import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  executeNativeHostClaim,
  type NativeCandidateReadAuthority,
  type NativeHostExecutorDependencies
} from "../../../../core/packages/core/src/nativeOrdinaryExecutor.js";
import { nativeDescriptorDigest } from "../../../../core/packages/core/src/nativeOrdinaryAuthorityProtocol.js";
import { ProcessRunner } from "../../../../core/packages/core/src/runner.js";
import { execution } from "./nativeOrdinaryExecutorFixture.js";

const runner = new ProcessRunner();
const dockerInfo = await runner.run("docker", ["info", "--format", "{{json .Runtimes}}"], {
  signal: AbortSignal.timeout(30_000)
});
const hasSysbox = dockerInfo.exitCode === 0 && Object.hasOwn(JSON.parse(dockerInfo.stdout) as object, "sysbox-runc");
const runnerImage = process.env.DIM_TEST_NATIVE_RUNNER_IMAGE;
const jobImage = process.env.DIM_TEST_NATIVE_JOB_IMAGE;
const hasImages = isDigestImage(runnerImage) && isDigestImage(jobImage);

describe("native ordinary executor live Docker driver", () => {
  it("reads the real Docker daemon runtime inventory", () => {
    // Given / When / Then
    expect(dockerInfo.exitCode).toBe(0);
    expect(JSON.parse(dockerInfo.stdout)).toBeTypeOf("object");
  });

  it.skipIf(!hasSysbox || !hasImages)("runs a digest-pinned nested job only with an available Sysbox fixture", async () => {
    // Given
    if (runnerImage === undefined || jobImage === undefined) throw new TypeError("digest fixture images are missing");
    const input = execution();
    const config = Buffer.from(`schemaVersion: 2\nordinary:\n  jobs:\n    source:\n      image: ${jobImage}\n      script: .dim/ci/jobs/source.bash\n      argv: [/bin/bash, --noprofile, --norc, /run/dim/job/script]\n`);
    const script = Buffer.from("printf 'native-live-output\\n'\n");
    const descriptor = {
      ...input.claim.descriptor,
      runnerBaseImage: runnerImage,
      jobImage,
      configBlob: { ...input.claim.descriptor.configBlob, sha256: digest(config) },
      script: { ...input.claim.descriptor.script, sha256: digest(script) }
    };
    const candidate = readAuthority(config, script);
    const claim = { ...input.claim, descriptor, descriptorDigest: nativeDescriptorDigest(descriptor) };
    const reports: unknown[] = [];
    const dependencies: NativeHostExecutorDependencies = {
      runner, createReadAuthority: async () => candidate,
      async renewClaim(request) {
        return { schemaVersion: 1, serviceId: claim.serviceId, requestId: request.requestId, claimId: claim.claimId,
          leaseExpiresAt: Date.now() + 60_000, leaseDurationMilliseconds: 60_000 };
      },
      async reportResult(request) { reports.push(request); },
      async recoverClaim() { throw new Error("live job unexpectedly lost its lease"); }
    };

    // When
    const completed = await executeNativeHostClaim(dependencies, { claim });

    // Then
    expect(completed.disposition).toBe("reported");
    expect(completed.stdout.toString()).toContain("native-live-output");
    expect(reports).toHaveLength(1);
  }, 120_000);
});

function readAuthority(config: Buffer, script: Buffer): NativeCandidateReadAuthority {
  return {
    async resolveProtectedHead() { return "1".repeat(40); },
    async readCommit() { return { objectId: "2".repeat(40), treeObjectId: "3".repeat(40) }; },
    async readBlob(input) {
      return input.path === ".dim/ci/runner.yml"
        ? { objectId: "4".repeat(40), mode: "100644", bytes: config }
        : { objectId: "5".repeat(40), mode: "100755", bytes: script };
    },
    async materializeTree(input) {
      await mkdir(input.destination, { recursive: true });
      await writeFile(`${input.destination}/README`, "live verified tree\n");
      return { commitObjectId: "2".repeat(40), treeObjectId: "3".repeat(40) };
    }
  };
}

function digest(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function isDigestImage(value: string | undefined): value is string {
  return value !== undefined && /@sha256:[0-9a-f]{64}$/.test(value);
}
