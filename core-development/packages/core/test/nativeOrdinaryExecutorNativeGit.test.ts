import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createNativeGitCandidateReadAuthorityFactory,
  NativeGitCandidateReadError
} from "../../../../core/packages/core/src/nativeGitCandidateReadAuthority.js";
import {
  executeNativeHostClaim,
  type NativeCandidateReadAuthorityFactoryInput
} from "../../../../core/packages/core/src/nativeOrdinaryExecutor.js";
import { nativeDescriptorDigest } from "../../../../core/packages/core/src/nativeOrdinaryAuthorityProtocol.js";
import { candidateReadFixture, type CandidateReadFixture } from "./nativeGitCandidateReadFixture.js";
import {
  dependencies,
  execution,
  ExecutorRunner,
  jobImage
} from "./nativeOrdinaryExecutorFixture.js";

const fixtures: CandidateReadFixture[] = [];
const readerPassword = "reader-a-secret-1";

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.native.close()));
});

describe("native ordinary executor with native Git candidate reader", () => {
  it("fetches and verifies the exact claim into the executor root before fake Docker launch", async () => {
    // Given
    const fixture = await startFixture();
    const candidate = await executableCandidate(fixture, "trusted candidate\n");
    const input = await claimedExecution(fixture, candidate);
    const runner = new ExecutorRunner();
    const reports: unknown[] = [];
    let factoryInput: NativeCandidateReadAuthorityFactoryInput | undefined;
    let verifiedAtLaunch = false;
    runner.beforeLaunch = async (args) => {
      const mount = args.find((argument) => argument.endsWith(",target=/workspace"));
      expect(mount).toBeDefined();
      if (mount === undefined) throw new TypeError("workspace mount is missing");
      const workspace = mount.slice("type=bind,source=".length, -",target=/workspace".length);
      await expect(readFile(join(workspace, "trusted.txt"), "utf8")).resolves.toBe("trusted candidate\n");
      verifiedAtLaunch = true;
    };
    const nativeFactory = createNativeGitCandidateReadAuthorityFactory({
      gitExecutable: fixture.native.config.gitExecutable,
      serviceEndpoint: fixture.native.baseUrl,
      credential: { username: "reader-a", password: readerPassword }
    });
    const executorDependencies = {
      ...dependencies(runner),
      createReadAuthority(factoryRequest: NativeCandidateReadAuthorityFactoryInput) {
        factoryInput = factoryRequest;
        return nativeFactory(factoryRequest);
      },
      async reportResult(request: unknown) { reports.push(request); }
    };

    // When
    const completed = await executeNativeHostClaim(executorDependencies, input);

    // Then
    expect(completed.disposition).toBe("reported");
    expect(factoryInput?.claim).toBe(input.claim);
    expect(factoryInput?.signal.aborted).toBe(false);
    expect(verifiedAtLaunch).toBe(true);
    expect(runner.calls.findIndex((call) => call.args[0] === "run"))
      .toBeGreaterThan(runner.calls.findIndex((call) => call.args[0] === "pull"));
    expect(reports).toHaveLength(1);
    const observableExecution = JSON.stringify({ calls: runner.calls, completed, reports });
    expect(observableExecution).not.toContain("reader-a");
    expect(observableExecution).not.toContain(readerPassword);
    if (factoryInput === undefined) throw new TypeError("reader factory was not invoked");
    await expect(stat(factoryInput.privateRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a reader bound to another candidate before image pull or Docker launch", async () => {
    // Given
    const fixture = await startFixture();
    const staleCandidate = await executableCandidate(fixture, "stale candidate\n");
    const claimedCandidate = await executableCandidate(fixture, "claimed candidate\n");
    const input = await claimedExecution(fixture, claimedCandidate);
    const runner = new ExecutorRunner();
    const recoverClaim = vi.fn();
    let privateRoot: string | undefined;
    const foreignAuthority = fixture.authority(staleCandidate);
    const executorDependencies = {
      ...dependencies(runner),
      recoverClaim,
      createReadAuthority(factoryRequest: NativeCandidateReadAuthorityFactoryInput) {
        privateRoot = factoryRequest.privateRoot;
        return foreignAuthority;
      }
    };

    // When
    const run = executeNativeHostClaim(executorDependencies, input);

    // Then
    await expect(run).rejects.toBeInstanceOf(NativeGitCandidateReadError);
    expect(runner.calls.some((call) => call.args[0] === "pull" || call.args[0] === "run")).toBe(false);
    expect(recoverClaim).toHaveBeenCalledOnce();
    if (privateRoot === undefined) throw new TypeError("reader factory was not invoked");
    await expect(stat(privateRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function startFixture(): Promise<CandidateReadFixture> {
  const fixture = await candidateReadFixture();
  fixtures.push(fixture);
  return fixture;
}

async function executableCandidate(
  fixture: CandidateReadFixture,
  trustedContents: string
): Promise<{
  readonly commit: string;
  readonly tree: string;
  readonly config: Buffer;
  readonly script: Buffer;
}> {
  const config = Buffer.from(candidateConfig());
  const script = Buffer.from(`printf 'executor-output\\n'\n# ${trustedContents.trim()}\n`);
  await mkdir(join(fixture.clone, ".dim/ci/jobs"), { recursive: true });
  await writeFile(join(fixture.clone, ".dim/ci/runner.yml"), config);
  await writeFile(join(fixture.clone, ".dim/ci/jobs/source.bash"), script);
  await writeFile(join(fixture.clone, "trusted.txt"), trustedContents);
  await fixture.native.git(fixture.clone, ["add", "--", ".dim/ci/runner.yml", ".dim/ci/jobs/source.bash", "trusted.txt"]);
  await fixture.native.git(fixture.clone, ["commit", "-m", `candidate ${trustedContents.trim()}`]);
  const candidate = {
    commit: (await fixture.native.git(fixture.clone, ["rev-parse", "HEAD"])).stdout.trim(),
    tree: (await fixture.native.git(fixture.clone, ["rev-parse", "HEAD^{tree}"])).stdout.trim(),
    config,
    script
  };
  await fixture.push(candidate.commit, `candidate-${candidate.commit.slice(0, 12)}`);
  return candidate;
}

async function claimedExecution(
  fixture: CandidateReadFixture,
  candidate: {
    readonly commit: string;
    readonly tree: string;
    readonly config: Buffer;
    readonly script: Buffer;
  }
): Promise<ReturnType<typeof execution>> {
  const baseline = execution();
  const descriptor = {
    ...baseline.claim.descriptor,
    expectedProtectedHead: fixture.initialHead,
    candidateCommit: candidate.commit,
    candidateTree: candidate.tree,
    configBlob: {
      objectId: await gitObjectId(fixture, candidate.commit, ".dim/ci/runner.yml"),
      sha256: digest(candidate.config)
    },
    script: {
      ...baseline.claim.descriptor.script,
      objectId: await gitObjectId(fixture, candidate.commit, ".dim/ci/jobs/source.bash"),
      sha256: digest(candidate.script)
    }
  };
  return {
    claim: {
      ...baseline.claim,
      descriptor,
      descriptorDigest: nativeDescriptorDigest(descriptor)
    }
  };
}

async function gitObjectId(fixture: CandidateReadFixture, commit: string, path: string): Promise<string> {
  return (await fixture.native.git(fixture.clone, ["rev-parse", `${commit}:${path}`])).stdout.trim();
}

function candidateConfig(): string {
  return `schemaVersion: 2\nordinary:\n  jobs:\n    source:\n      image: ${jobImage}\n      script: .dim/ci/jobs/source.bash\n      argv: [/bin/bash, --noprofile, --norc, /run/dim/job/script]\n`;
}

function digest(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
