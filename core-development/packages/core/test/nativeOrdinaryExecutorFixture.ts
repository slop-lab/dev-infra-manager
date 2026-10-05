import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import type {
  NativeCandidateReadAuthority,
  NativeHostExecutorDependencies,
  NativeHostExecution
} from "../../../../core/packages/core/src/nativeOrdinaryExecutor.js";
import { nativeDescriptorDigest, type NativeOrdinaryDescriptor } from "../../../../core/packages/core/src/nativeOrdinaryAuthorityProtocol.js";
import type { CommandResult, RunOptions, StreamingCommandRunner } from "../../../../core/packages/core/src/types.js";

export const runnerImage = `registry.example/runner@sha256:${"b".repeat(64)}`;
export const jobImage = `registry.example/job@sha256:${"a".repeat(64)}`;
export const configBytes = Buffer.from(`schemaVersion: 2\nordinary:\n  jobs:\n    source:\n      image: ${jobImage}\n      script: .dim/ci/jobs/source.bash\n      argv: [/bin/bash, --noprofile, --norc, /run/dim/job/script]\n`);
const scriptBytes = Buffer.from("printf 'executor-output\\n'\n");

export function execution(candidateConfig = configBytes): NativeHostExecution {
  const descriptor: NativeOrdinaryDescriptor = {
    projectId: "project-a", repositoryId: "source", protectedRef: "refs/heads/main",
    expectedProtectedHead: "1".repeat(40), candidateCommit: "2".repeat(40), candidateTree: "3".repeat(40),
    policyRevision: "policy-1", requiredReviewRevision: "review-1", requiredJobSetRevision: "jobs-1",
    admissionGeneration: "generation-1", jobName: "source", evidenceClass: "candidate-controlled",
    configBlob: { objectId: "4".repeat(40), sha256: digest(candidateConfig) },
    script: { path: ".dim/ci/jobs/source.bash", objectId: "5".repeat(40), sha256: digest(scriptBytes) },
    argv: ["/bin/bash", "--noprofile", "--norc", "/run/dim/job/script"],
    jobImage, runnerBaseImage: runnerImage,
    bounds: { cpu: "2", memoryBytes: "536870912", pids: "128", wallClockSeconds: "30", outputBytes: "1024" }
  };
  return {
    claim: {
      schemaVersion: 1, serviceId: "ordinary-main", requestId: "10000000-0000-4000-8000-000000000001",
      claimId: "20000000-0000-4000-8000-000000000001", eventId: "30000000-0000-4000-8000-000000000001",
      reviewId: "6".repeat(64), attemptId: "40000000-0000-4000-8000-000000000001",
      attempt: 1,
      admissionGeneration: "generation-1", hostId: "host-a", capacity: "primary", leaseExpiresAt: Date.now() + 60_000,
      descriptor, descriptorDigest: nativeDescriptorDigest(descriptor)
    }
  };
}

export function authority(
  overrides: Partial<NativeCandidateReadAuthority> = {},
  candidateConfig = configBytes
): NativeCandidateReadAuthority {
  return {
    async resolveProtectedHead() { return "1".repeat(40); },
    async readCommit() { return { objectId: "2".repeat(40), treeObjectId: "3".repeat(40) }; },
    async readBlob(input) {
      return input.path === ".dim/ci/runner.yml"
        ? { objectId: "4".repeat(40), mode: "100644", bytes: candidateConfig }
        : { objectId: "5".repeat(40), mode: "100755", bytes: scriptBytes };
    },
    async materializeTree(input) {
      await mkdir(input.destination, { recursive: true });
      await writeFile(`${input.destination}/README`, "verified tree\n");
      return { commitObjectId: "2".repeat(40), treeObjectId: "3".repeat(40) };
    },
    ...overrides
  };
}

export class ExecutorRunner implements StreamingCommandRunner {
  readonly calls: Array<{ readonly command: string; readonly args: readonly string[] }> = [];
  failRemoval = false;
  foreignOwnership = false;
  imageMismatch = false;
  launchResponseLost = false;
  abortOnWait: AbortController | undefined;
  logsExitCode = 0;
  logsWaitForAbort = false;
  waitCommandExitCode = 0;
  waitForAbort = false;
  waitUntil: Promise<void> | undefined;
  onWait: (() => void) | undefined;
  output = "executor-output\n";
  exitCode = 0;
  beforeLaunch: ((args: readonly string[]) => Promise<void>) | undefined;
  private labels: readonly string[] = [];

  async run(command: string, args: string[], options?: RunOptions): Promise<CommandResult> {
    this.calls.push({ command, args: [...args] });
    if (args[0] === "image" && args[1] === "inspect") {
      const image = args[2] ?? "";
      return result(command, args, JSON.stringify(this.imageMismatch ? [] : [image]));
    }
    if (args[0] === "run") {
      await this.beforeLaunch?.(args);
      this.labels = args.flatMap((value, index) => args[index - 1] === "--label" ? [value] : []);
      if (this.launchResponseLost) return result(command, args, "", 125);
      return result(command, args, `${"c".repeat(64)}\n`);
    }
    if (args[0] === "wait") {
      this.onWait?.();
      this.abortOnWait?.abort();
      await this.waitUntil;
      if (this.waitForAbort && !options?.signal?.aborted) await new Promise<void>((resolve) => options?.signal?.addEventListener("abort", () => resolve(), { once: true }));
      return result(command, args, `${this.exitCode}\n`, this.waitCommandExitCode);
    }
    if (args[0] === "container" && args[1] === "inspect") {
      if (this.labels.length === 0) {
        return { command, args, stdout: "", stderr: `Error: No such container: ${args[2] ?? ""}`, exitCode: 1 };
      }
      const values = this.labels.map((label) => label.slice(label.indexOf("=") + 1));
      if (this.foreignOwnership) values[1] = "foreign";
      return result(command, args, `${"c".repeat(64)}|${values.join("|")}\n`);
    }
    if (args[0] === "container" && args[1] === "rm") return result(command, args, "", this.failRemoval ? 1 : 0);
    return result(command, args);
  }

  async runStreaming(command: string, args: string[], options?: RunOptions): Promise<number> {
    this.calls.push({ command, args: [...args] });
    options?.stdout?.write(this.output);
    if (this.logsWaitForAbort && !options?.signal?.aborted) {
      await new Promise<void>((resolve) => options?.signal?.addEventListener("abort", () => resolve(), { once: true }));
    }
    return this.logsExitCode;
  }
}

export function dependencies(runner: ExecutorRunner, readAuthority = authority()): NativeHostExecutorDependencies {
  let id = 0;
  return {
    runner,
    createReadAuthority: async () => readAuthority,
    async renewClaim(request) {
      return { schemaVersion: 1, serviceId: "ordinary-main", requestId: request.requestId, claimId: request.claimId,
        leaseExpiresAt: Date.now() + 60_000, leaseDurationMilliseconds: 60_000 };
    },
    async reportResult() {},
    async recoverClaim() {},
    randomId() { id += 1; return `90000000-0000-4000-8000-${String(id).padStart(12, "0")}`; }
  };
}

function digest(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function result(command: string, args: string[], stdout = "", exitCode = 0): CommandResult {
  return { command, args, stdout, stderr: exitCode === 0 ? "" : "failed", exitCode };
}
