import { describe, expect, it, vi } from "vitest";
import { executeNativeHostClaim, NativeHostCleanupError, NativeHostLaunchError, NativeHostVerificationError } from "../../../../core/packages/core/src/nativeOrdinaryExecutor.js";
import { NativeHostImageError } from "../../../../core/packages/core/src/nativeOrdinaryExecutorDocker.js";
import { nativeRunnerScript } from "../../../../core/packages/core/src/nativeOrdinaryExecutorDocker.js";
import { parseNativeHostResultRequest } from "../../../../core/packages/core/src/nativeOrdinaryResultProtocol.js";
import { authority, configBytes, dependencies, execution, ExecutorRunner, jobImage, runnerImage } from "./nativeOrdinaryExecutorFixture.js";

describe("native ordinary host claim executor", () => {
  it("verifies candidate bytes and runs exact argv without authority in the job", async () => {
    // Given
    const runner = new ExecutorRunner();
    const reports: unknown[] = [];
    const fixture = { ...dependencies(runner), reportResult: async (request: unknown) => {
      expect(runner.calls.at(-1)?.args.slice(0, 3)).toEqual(["container", "rm", "--force"]);
      reports.push(parseNativeHostResultRequest(request));
    } };

    // When
    const completed = await executeNativeHostClaim(fixture, execution());

    // Then
    expect(completed.disposition).toBe("reported");
    expect(completed.stdout.toString()).toBe("executor-output\n");
    expect(completed.terminalEvent.payload.attempt).toBe(1);
    expect(reports).toHaveLength(1);
    const launch = runner.calls.find((call) => call.args[0] === "run");
    expect(launch?.args).toEqual(expect.arrayContaining([
      "--runtime", "sysbox-runc", "--cpus", "2", "--memory", "536870912", "--pids-limit", "128",
      "--mount", expect.stringContaining("target=/run/dim/job/script,readonly"),
      "--entrypoint", "/bin/bash", runnerImage, "--noprofile", "--norc", "/run/dim/runner"
    ]));
    expect(launch?.args.join(" ")).not.toMatch(/token|password|credential|docker\.sock|\/dev\/kvm/);
    expect(nativeRunnerScript()).toContain("--entrypoint /bin/bash \"$DIM_JOB_IMAGE\" --noprofile --norc /run/dim/job/script");
    expect(nativeRunnerScript()).toContain("DOCKER_HOST=unix:///run/dim/docker.sock");
    expect(nativeRunnerScript()).toContain("dockerd-entrypoint.sh --host=\"$DOCKER_HOST\"");
    expect(nativeRunnerScript()).toContain("docker run --rm --network none");
    expect(runner.calls.filter((call) => call.args[0] === "pull").map((call) => call.args[1])).toEqual([runnerImage]);
    expect(runner.calls.at(-1)?.args.slice(0, 3)).toEqual(["container", "rm", "--force"]);
  });

  it("removes an exactly owned container when the detached launch response is lost", async () => {
    // Given
    const runner = new ExecutorRunner();
    runner.launchResponseLost = true;
    const report = vi.fn();

    // When / Then
    await expect(executeNativeHostClaim({ ...dependencies(runner), reportResult: report }, execution()))
      .rejects.toBeInstanceOf(NativeHostLaunchError);
    expect(runner.calls.some((call) => call.args.slice(0, 3).join(" ") === "container rm --force")).toBe(true);
    expect(report).not.toHaveBeenCalled();
  });

  it.each([
    ["logs", { logsExitCode: 127, waitCommandExitCode: 0 }],
    ["wait", { logsExitCode: 0, waitCommandExitCode: 125 }]
  ])("reports executor failure when the Docker %s observer fails", async (_observer, statuses) => {
    // Given
    const runner = new ExecutorRunner();
    runner.logsExitCode = statuses.logsExitCode;
    runner.waitCommandExitCode = statuses.waitCommandExitCode;

    // When
    const completed = await executeNativeHostClaim(dependencies(runner), execution());

    // Then
    expect(completed.terminalEvent.payload.result).toBe("failure");
    expect(completed.terminalEvent.payload.completion).toEqual({ kind: "executor-failure", code: "container-observer-failed" });
  });

  it("reports cancellation after cleanup with a reporting signal independent of caller cancellation", async () => {
    // Given
    const runner = new ExecutorRunner();
    const cancellation = new AbortController();
    runner.abortOnWait = cancellation;
    const reports: unknown[] = [];
    const fixture = {
      ...dependencies(runner),
      async reportResult(request: unknown, signal: AbortSignal) {
        expect(signal.aborted).toBe(false);
        reports.push(request);
      }
    };

    // When
    const completed = await executeNativeHostClaim(fixture, { ...execution(), signal: cancellation.signal });

    // Then
    expect(completed.disposition).toBe("reported");
    expect(completed.terminalEvent.payload.completion).toEqual({ kind: "cancelled" });
    expect(reports).toHaveLength(1);
  });

  it("retries the exact terminal request after a lost report response", async () => {
    // Given
    const runner = new ExecutorRunner();
    const reports: unknown[] = [];
    let attempts = 0;
    const fixture = {
      ...dependencies(runner),
      async reportResult(request: unknown) {
        reports.push(request);
        attempts += 1;
        if (attempts === 1) throw new Error("response lost");
      },
      async recoverClaim() { throw new Error("recovery is not expected"); }
    };

    // When
    const completed = await executeNativeHostClaim(fixture, execution());

    // Then
    expect(completed.disposition).toBe("reported");
    expect(reports).toHaveLength(2);
    expect(reports[1]).toEqual(reports[0]);
  });

  it("recovers cleaned capacity after terminal reporting remains unavailable", async () => {
    // Given
    const runner = new ExecutorRunner();
    const reports: unknown[] = [];
    const recoveries: unknown[] = [];
    const fixture = {
      ...dependencies(runner),
      async reportResult(request: unknown) {
        expect(runner.calls.at(-1)?.args.slice(0, 3)).toEqual(["container", "rm", "--force"]);
        reports.push(request);
        throw new Error("reporter unavailable");
      },
      async recoverClaim(request: unknown) { recoveries.push(request); }
    };

    // When
    const completed = await executeNativeHostClaim(fixture, execution());

    // Then
    expect(completed.disposition).toBe("recovered");
    expect(completed.terminalEvent.payload.completion).toEqual({ kind: "executor-failure", code: "result-submission-failed" });
    expect(reports).toHaveLength(3);
    expect(recoveries).toHaveLength(1);
  });

  it("retains the reporting failure when its fenced recovery also fails", async () => {
    // Given
    const runner = new ExecutorRunner();
    const reportFailure = new Error("reporter unavailable");
    const recoveryFailure = new Error("recovery unavailable");
    const fixture = {
      ...dependencies(runner),
      async reportResult() { throw reportFailure; },
      async recoverClaim() { throw recoveryFailure; }
    };

    // When / Then
    await expect(executeNativeHostClaim(fixture, execution())).rejects.toMatchObject({
      cause: reportFailure,
      recoveryError: recoveryFailure
    });
  });

  it("rejects an image whose inspected repository digests do not contain the claimed digest", async () => {
    // Given
    const runner = new ExecutorRunner();
    runner.imageMismatch = true;
    const recover = vi.fn();

    // When / Then
    await expect(executeNativeHostClaim({ ...dependencies(runner), recoverClaim: recover }, execution()))
      .rejects.toBeInstanceOf(NativeHostImageError);
    expect(runner.calls.some((call) => call.args[0] === "run")).toBe(false);
    expect(runner.calls.some((call) => call.args.slice(0, 2).join(" ") === "container inspect")).toBe(true);
    expect(recover).toHaveBeenCalledOnce();
  });

  it("recovers cleaned capacity after an uncertain initial renewal", async () => {
    // Given
    const runner = new ExecutorRunner();
    const recover = vi.fn();
    const fixture = {
      ...dependencies(runner),
      async renewClaim() { throw new Error("renewal response lost"); },
      recoverClaim: recover
    };

    // When / Then
    await expect(executeNativeHostClaim(fixture, execution())).rejects.toThrow("renewal response lost");
    expect(runner.calls.some((call) => call.args.slice(0, 2).join(" ") === "container inspect")).toBe(true);
    expect(recover).toHaveBeenCalledWith({
      schemaVersion: 1,
      requestId: "90000000-0000-4000-8000-000000000002",
      hostId: "host-a",
      capacity: "primary",
      claimId: "20000000-0000-4000-8000-000000000001",
      attemptId: "40000000-0000-4000-8000-000000000001",
      descriptorDigest: execution().claim.descriptorDigest,
      resourceId: "20000000-0000-4000-8000-000000000001",
      cleanupComplete: true
    }, expect.any(AbortSignal));
  });

  it("retains the execution failure when fenced recovery also fails", async () => {
    // Given
    const runner = new ExecutorRunner();
    runner.imageMismatch = true;
    const recoveryFailure = new Error("recovery unavailable");
    const fixture = {
      ...dependencies(runner),
      async recoverClaim() { throw recoveryFailure; }
    };

    // When / Then
    await expect(executeNativeHostClaim(fixture, execution())).rejects.toMatchObject({
      cause: expect.any(NativeHostImageError),
      recoveryError: recoveryFailure
    });
  });

  it.each([
    ["protected head", authority({ async resolveProtectedHead() { return "9".repeat(40); } })],
    ["commit tree", authority({ async readCommit() { return { objectId: "2".repeat(40), treeObjectId: "9".repeat(40) }; } })],
    ["config blob", authority({ async readBlob(input) { return { objectId: "9".repeat(40), mode: "100644", bytes: Buffer.from(input.path) }; } })]
  ])("rejects a wrong %s before Docker launch", async (_label, readAuthority) => {
    // Given
    const runner = new ExecutorRunner();

    // When / Then
    await expect(executeNativeHostClaim(dependencies(runner, readAuthority), execution())).rejects.toBeInstanceOf(NativeHostVerificationError);
    expect(runner.calls.some((call) => call.args[0] === "run")).toBe(false);
  });

  it("rejects a descriptor digest mismatch before reading candidate data", async () => {
    // Given
    const runner = new ExecutorRunner();
    const input = execution();

    // When / Then
    await expect(executeNativeHostClaim(dependencies(runner), {
      ...input, claim: { ...input.claim, descriptorDigest: `sha256:${"f".repeat(64)}` }
    })).rejects.toBeInstanceOf(NativeHostVerificationError);
    expect(runner.calls.some((call) => call.args[0] === "run")).toBe(false);
  });

  it("rejects a malformed sibling job before Docker launch", async () => {
    // Given
    const malformedConfig = Buffer.concat([
      configBytes,
      Buffer.from(`    sibling:\n      image: mutable:latest\n      script: ../escape.bash\n      argv: [/bin/bash]\n`)
    ]);
    const runner = new ExecutorRunner();

    // When / Then
    await expect(executeNativeHostClaim(
      dependencies(runner, authority({}, malformedConfig)),
      execution(malformedConfig)
    )).rejects.toBeInstanceOf(NativeHostVerificationError);
    expect(runner.calls.some((call) => call.args[0] === "run")).toBe(false);
  });

  it.each([
    ["candidate-selected image", Buffer.from(configBytes.toString("utf8").replace(
      "      script:", `      image: registry.example/foreign@sha256:${"c".repeat(64)}\n      script:`
    ))],
    ["schema-2 candidate config", Buffer.from(configBytes.toString("utf8").replace("schemaVersion: 3", "schemaVersion: 2"))]
  ])("rejects %s before image pull or Docker launch", async (_label, candidateConfig) => {
    const runner = new ExecutorRunner();

    await expect(executeNativeHostClaim(
      dependencies(runner, authority({}, candidateConfig)),
      execution(candidateConfig)
    )).rejects.toBeInstanceOf(NativeHostVerificationError);

    expect(runner.calls.some((call) => call.args[0] === "pull" || call.args[0] === "run")).toBe(false);
  });

  it("rejects a hidden protected ref before candidate reads", async () => {
    // Given
    const runner = new ExecutorRunner();
    const baseline = execution();
    const descriptor = { ...baseline.claim.descriptor, protectedRef: "refs/heads/.hidden" };
    const input = {
      ...baseline,
      claim: {
        ...baseline.claim,
        descriptor,
        descriptorDigest: (await import("../../../../core/packages/core/src/nativeOrdinaryAuthorityProtocol.js"))
          .nativeDescriptorDigest(descriptor)
      }
    };

    // When / Then
    await expect(executeNativeHostClaim(dependencies(runner), input)).rejects.toBeInstanceOf(NativeHostVerificationError);
    expect(runner.calls.some((call) => call.args[0] === "run")).toBe(false);
  });

  it("withholds the result and ownership release when cleanup fails or labels are foreign", async () => {
    // Given
    const report = vi.fn();
    const removalFailure = new ExecutorRunner();
    removalFailure.failRemoval = true;
    const foreign = new ExecutorRunner();
    foreign.foreignOwnership = true;
    const first = { ...dependencies(removalFailure), reportResult: report };
    const second = { ...dependencies(foreign), reportResult: report };

    // When / Then
    await expect(executeNativeHostClaim(first, execution())).rejects.toBeInstanceOf(NativeHostCleanupError);
    await expect(executeNativeHostClaim(second, execution())).rejects.toBeInstanceOf(NativeHostCleanupError);
    expect(report).not.toHaveBeenCalled();
    expect(foreign.calls.some((call) => call.args[0] === "container" && call.args[1] === "rm")).toBe(false);
  });
});
