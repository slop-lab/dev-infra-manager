import { afterEach, describe, expect, it, vi } from "vitest";
import { UserError } from "../../../../core/packages/core/src/errors.js";
import type { CiRunnerRecord } from "../../../../core/packages/core/src/lifecycleTypes.js";
import {
  assertOrdinaryPoolCapacityAvailable,
  ordinaryPoolContainerArgs,
  runOrdinaryPoolClaim,
  type OrdinaryPoolClaim,
  type OrdinaryPoolJobDependencies
} from "../../../../core/packages/core/src/ordinaryCiPoolWorker.js";
import type { CommandResult, RunOptions, StreamingCommandRunner } from "../../../../core/packages/core/src/types.js";

const RUNNER_IMAGE = `sha256:${"b".repeat(64)}`;
const JOB_IMAGE = `registry.example/dim/job@sha256:${"a".repeat(64)}`;

afterEach(() => vi.useRealTimers());

describe("ordinary CI pool host worker", () => {
  it("registers with the claimed organization only after claiming and releases after owned cleanup", async () => {
    // Given
    const events: string[] = [];
    const runner = new WorkerRunner(events);
    const claim = ordinaryClaim();
    const dependencies: OrdinaryPoolJobDependencies = {
      runner,
      prepareRegistration: async () => {
        events.push("register:dim-alpha");
        return { provider: "gitea-actions", instanceUrl: "https://runner.example", token: "registration-secret" };
      },
      renewClaim: async () => 60_000,
      releaseClaim: async () => { events.push("release"); }
    };

    // When
    await runOrdinaryPoolClaim(dependencies, workerPlan(claim));

    // Then
    expect(events).toEqual([
      "register:dim-alpha",
      "docker:run",
      "docker:inspect",
      "docker:remove",
      "release"
    ]);
    const launch = runner.calls.find((call) => call.args[0] === "run");
    expect(launch?.args.join(" ")).not.toContain("registration-secret");
    expect(launch?.args).not.toContain("/var/run/docker.sock");
    expect(launch?.args).not.toContain("/dev/kvm");
    expect(launch?.args).toContain(`GITEA_RUNNER_LABELS=dim-ordinary:docker://${JOB_IMAGE}`);
    expect(launch?.args).toContain("--rm");
  });

  it("retains the global claim when owned process cleanup fails", async () => {
    // Given
    const events: string[] = [];
    const runner = new WorkerRunner(events, true);
    const dependencies: OrdinaryPoolJobDependencies = {
      runner,
      prepareRegistration: async () => ({ provider: "gitea-actions", instanceUrl: "https://runner.example", token: "secret" }),
      renewClaim: async () => 60_000,
      releaseClaim: async () => { events.push("release"); }
    };

    // When
    const result = runOrdinaryPoolClaim(dependencies, workerPlan(ordinaryClaim()));

    // Then
    await expect(result).rejects.toThrow(/failed to clean up ordinary CI runner/);
    expect(events).not.toContain("release");
  });

  it("cleans and releases the claim when registration preparation fails", async () => {
    // Given
    const events: string[] = [];
    const runner = new WorkerRunner(events);
    const dependencies: OrdinaryPoolJobDependencies = {
      runner,
      prepareRegistration: async () => { throw new UserError("registration unavailable"); },
      renewClaim: async () => 60_000,
      releaseClaim: async () => { events.push("release"); }
    };

    // When
    const result = runOrdinaryPoolClaim(dependencies, workerPlan(ordinaryClaim()));

    // Then
    await expect(result).rejects.toThrow(/registration unavailable/);
    expect(events).toEqual(["docker:inspect", "release"]);
  });

  it("reaps and releases the claim when Docker execution fails", async () => {
    // Given
    const events: string[] = [];
    const dependencies: OrdinaryPoolJobDependencies = {
      runner: new WorkerRunner(events, false, true),
      prepareRegistration: async () => ({ provider: "gitea-actions", instanceUrl: "https://runner.example", token: "secret" }),
      renewClaim: async () => 60_000,
      releaseClaim: async () => { events.push("release"); }
    };

    // When
    const result = runOrdinaryPoolClaim(dependencies, workerPlan(ordinaryClaim()));

    // Then
    await expect(result).rejects.toThrow(/runner exited/);
    expect(events).toEqual(["docker:run", "docker:inspect", "docker:remove", "release"]);
  });

  it("aborts and reaps the owned process when lease renewal is lost", async () => {
    // Given
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const events: string[] = [];
    const runner = new LeaseLossRunner(events);
    let renewals = 0;
    const dependencies: OrdinaryPoolJobDependencies = {
      runner,
      prepareRegistration: async () => ({ provider: "gitea-actions", instanceUrl: "https://runner.example", token: "secret" }),
      renewClaim: async () => {
        renewals += 1;
        if (renewals === 3) throw new UserError("lease ownership lost");
        return 2;
      },
      releaseClaim: async () => { events.push("release"); }
    };
    const running = runOrdinaryPoolClaim(dependencies, workerPlan(ordinaryClaim()));
    await runner.started;
    await vi.advanceTimersByTimeAsync(1);

    // When
    const result = running;

    // Then
    await expect(result).rejects.toThrow(/lease ownership lost/);
    expect(events).toEqual(["docker:run", "docker:aborted", "docker:inspect", "docker:remove", "release"]);
  });

  it("treats an in-flight renewal aborted by a normally completed job as success", async () => {
    // Given
    vi.useFakeTimers();
    const events: string[] = [];
    const base = new WorkerRunner(events);
    const runner: StreamingCommandRunner = {
      async run(command, args) {
        if (args[0] === "run") await vi.advanceTimersByTimeAsync(1);
        return base.run(command, args);
      },
      async runStreaming() { return 0; }
    };
    let renewals = 0;
    const dependencies: OrdinaryPoolJobDependencies = {
      runner,
      async prepareRegistration() {
        return { provider: "gitea-actions", instanceUrl: "https://runner.example", token: "secret" };
      },
      async renewClaim(_claim, signal) {
        renewals += 1;
        if (renewals < 3) return 2;
        return new Promise<number>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
      async releaseClaim() { events.push("release"); }
    };

    // When
    const completed = runOrdinaryPoolClaim(dependencies, workerPlan(ordinaryClaim()));

    // Then
    await expect(completed).resolves.toBeUndefined();
    expect(renewals).toBe(3);
    expect(events).toEqual(["docker:run", "docker:inspect", "docker:remove", "release"]);
  });

  it("rejects any active legacy Project-scoped Sysbox runner regardless of capacity name", () => {
    // Given
    const legacy = [{
      name: "unrelated-capacity",
      executor: { kind: "sysbox", phase: "ready" }
    }] as Pick<CiRunnerRecord, "name" | "executor">[];

    // When
    const act = () => assertOrdinaryPoolCapacityAvailable(legacy, "primary");

    // Then
    expect(act).toThrow(UserError);
    expect(act).toThrow(/legacy Project-scoped Sysbox runner.*unrelated-capacity/);
  });

  it("builds a disposable Sysbox launch with the control-plane image and no host devices", () => {
    // Given
    const plan = workerPlan(ordinaryClaim());

    // When
    const args = ordinaryPoolContainerArgs(plan, {
      file: "/private/registration-token",
      registryConfigFile: "/private/docker-daemon.json",
      instanceUrl: "https://runner.example"
    });

    // Then
    expect(args).toEqual(expect.arrayContaining([
      "--runtime", "sysbox-runc",
      "--mount", "type=bind,source=/private/registration-token,target=/run/secrets/gitea-registration-token,readonly",
      "--mount", "type=bind,source=/private/docker-daemon.json,target=/etc/docker/daemon.json,readonly",
      "--add-host=registry-1.docker.io:127.0.0.1",
      "--add-host=auth.docker.io:127.0.0.1",
      "--env", "GITEA_RUNNER_REGISTRATION_TOKEN_FILE=/run/secrets/gitea-registration-token",
      "--env", "GITEA_RUNNER_EPHEMERAL=1",
      "--env", "GITEA_RUNNER_ONCE=1",
      "--env", `GITEA_RUNNER_LABELS=dim-ordinary:docker://${JOB_IMAGE}`,
      RUNNER_IMAGE
    ]));
    expect(args).not.toContain("--device");
    expect(args.join(" ")).not.toContain("docker.sock");
  });

  it("rejects an ordinary pool runtime that is not Sysbox", () => {
    // Given
    const plan = { ...workerPlan(ordinaryClaim()), runnerRuntime: "runc" };

    // When
    const launch = () => ordinaryPoolContainerArgs(plan, {
      file: "/private/registration-token",
      registryConfigFile: "/private/docker-daemon.json",
      instanceUrl: "https://runner.example"
    });

    // Then
    expect(launch).toThrow(/Sysbox runtime/);
  });
});

class WorkerRunner implements StreamingCommandRunner {
  readonly calls: Array<{ readonly command: string; readonly args: readonly string[] }> = [];

  constructor(
    private readonly events: string[],
    private readonly failCleanup = false,
    private readonly failRun = false
  ) {}

  async run(command: string, args: string[]): Promise<CommandResult> {
    this.calls.push({ command, args });
    const launched = this.calls.some((call) => call.args[0] === "run");
    if (args[0] === "run") this.events.push("docker:run");
    if (args[0] === "container" && args[1] === "inspect") this.events.push("docker:inspect");
    if (args[0] === "container" && args[1] === "rm") this.events.push("docker:remove");
    const failed = (this.failRun && args[0] === "run")
      || (!launched && args[0] === "container" && args[1] === "inspect")
      || (this.failCleanup && args[0] === "container" && args[1] === "rm");
    return {
      command,
      args,
      stdout: launched && args[0] === "container" && args[1] === "inspect"
        ? "owned-container-id|true|dim|host-a|primary|claim-1234567890|project-a|ci-ordinary-job\n"
        : "",
      stderr: !launched && args[0] === "container" && args[1] === "inspect"
        ? `Error: No such container: ${args[2] ?? ""}`
        : this.failCleanup && args[0] === "container" && args[1] === "rm" ? "busy" : "",
      exitCode: failed ? 1 : 0
    };
  }

  async runStreaming(): Promise<number> { return 0; }
}

class LeaseLossRunner implements StreamingCommandRunner {
  readonly started: Promise<void>;
  private readonly markStarted: () => void;

  constructor(private readonly events: string[]) {
    let resolveStarted: (() => void) | undefined;
    this.started = new Promise<void>((resolve) => { resolveStarted = resolve; });
    if (resolveStarted === undefined) throw new Error("start signal initialization failed");
    this.markStarted = resolveStarted;
  }

  async run(command: string, args: string[], options?: RunOptions): Promise<CommandResult> {
    if (args[0] === "run") {
      this.events.push("docker:run");
      this.markStarted();
      await new Promise<void>((resolve) => options?.signal?.addEventListener("abort", () => {
        this.events.push("docker:aborted");
        resolve();
      }, { once: true }));
      return { command, args, stdout: "", stderr: "aborted", exitCode: 143 };
    }
    if (args[0] === "container" && args[1] === "inspect") {
      this.events.push("docker:inspect");
      return { command, args, stdout: "owned-container-id|true|dim|host-a|primary|claim-1234567890|project-a|ci-ordinary-job\n", stderr: "", exitCode: 0 };
    }
    this.events.push("docker:remove");
    return { command, args, stdout: "", stderr: "", exitCode: 0 };
  }

  async runStreaming(): Promise<number> { return 0; }
}

function ordinaryClaim(): OrdinaryPoolClaim {
  return {
    claimId: "claim-1234567890",
    jobId: 101,
    projectId: "project-a",
    projectName: "alpha",
    organization: "dim-alpha",
    organizationId: 41,
    jobImage: JOB_IMAGE,
    runnerLabel: "dim-ordinary",
    leaseMilliseconds: 60_000
  };
}

function workerPlan(claim: OrdinaryPoolClaim) {
  return {
    claim,
    hostId: "host-a",
    capacity: "primary",
    runnerImage: RUNNER_IMAGE,
    runnerRuntime: "sysbox-runc",
    resources: { cpus: "4", memory: "8g", pidsLimit: "2048" }
  } as const;
}
