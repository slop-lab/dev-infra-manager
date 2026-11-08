import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ProcessRunner } from "../../../../packages/host/core/src/runner.js";
import type { VmBudget } from "../../../../packages/host/plugins/vm/src/budget.js";
import { parseVmHostConfig } from "../../../../packages/host/plugins/vm/src/config.js";
import { IncusMachines } from "../../../../packages/host/plugins/vm/src/incus.js";
import { IncusWorkspaceRuntime } from "../../../../packages/host/plugins/vm/src/runtime.js";
import { VmStartupDeadline } from "../../../../packages/host/plugins/vm/src/startup.js";
import { config, FakeIncus, workspace } from "./fixture.js";

afterEach(() => vi.restoreAllMocks());

it("normalizes one strict operator startup policy", () => {
  const { startupTimeoutMilliseconds: _ignored, ...without } = config;
  expect(parseVmHostConfig(without).startupTimeoutMilliseconds).toBe(300_000);
  expect(parseVmHostConfig({ ...without, startupTimeoutMilliseconds: 420_000 }).startupTimeoutMilliseconds).toBe(420_000);
  for (const value of [null, "300000", 0, 999, 900_001, 1.5, Infinity, NaN]) {
    expect(() => parseVmHostConfig({ ...without, startupTimeoutMilliseconds: value })).toThrow(/startupTimeoutMilliseconds/);
  }
});

it("shares one budget across admission, agent and Docker, rejecting a late successful probe before readiness", async () => {
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const runner = new FakeIncus(); runner.exists = true;
  const run = runner.run.bind(runner), stages: string[] = [];
  vi.spyOn(runner, "run").mockImplementation(async (command, args, options) => {
    if (args.includes("exec")) {
      expect(options?.signal).toBeInstanceOf(AbortSignal);
      if (args.at(-1) === "true") { stages.push("agent"); now += 350; }
      if (args.includes("docker")) { stages.push("docker"); now += 350; }
    }
    return run(command, args, options);
  });
  const release = vi.fn(async (_instance: string) => { expect(runner.running).toBe(false); });
  const machines = new IncusMachines({ ...config, startupTimeoutMilliseconds: 1000 }, runner, {
    prepare: async () => { now += 350; }, apply: async () => {}, verify: async () => {}, release
  });
  const finish = vi.fn();
  await expect(machines.startReady(workspace(), finish)).rejects.toThrow(/deadline.*guest Docker/);
  expect(stages).toEqual(["agent", "docker"]); expect(finish).not.toHaveBeenCalled();
  expect(runner.running).toBe(false); expect(release).toHaveBeenCalledOnce();
});

it("bounds workspace helper installation after readiness and rolls back a new VM", async () => {
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const runner = new FakeIncus(); runner.exists = true;
  const run = runner.run.bind(runner);
  vi.spyOn(runner, "run").mockImplementation(async (command, args, options) => {
    if (args.includes("file") && args.includes("push")) now = 1001;
    return run(command, args, options);
  });
  const machines = new IncusMachines({ ...config, startupTimeoutMilliseconds: 1000 }, runner, { apply: async () => {}, verify: async () => {} });
  await expect(new IncusWorkspaceRuntime(machines).start(workspace())).rejects.toThrow(/deadline.*guest readiness/);
  expect(runner.running).toBe(false);
  expect(runner.calls.some((args) => args.includes("daemon-reload"))).toBe(false);
});

it("preserves an already-running VM on readiness expiry, while unconfirmed ceilings still force-stop it", async () => {
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const runner = new FakeIncus(); runner.exists = true; runner.running = true;
  const run = runner.run.bind(runner);
  vi.spyOn(runner, "run").mockImplementation(async (command, args, options) => {
    if (args.includes("docker")) now = 1001;
    return run(command, args, options);
  });
  const machines = new IncusMachines({ ...config, startupTimeoutMilliseconds: 1000 }, runner, { apply: async () => {}, verify: async () => {} });
  await expect(machines.startReady(workspace())).rejects.toThrow(/deadline/);
  expect(runner.running).toBe(true); expect(runner.calls.some((args) => args[0] === "stop")).toBe(false);
  now = 0;
  const unsafe = new IncusMachines(config, runner, { apply: async () => { throw new Error("budget unconfirmed"); }, verify: async () => {} });
  await expect(unsafe.startReady(workspace())).rejects.toThrow("budget unconfirmed");
  expect(runner.running).toBe(false);
});

it("rejects parent cancellation even when a probe returns zero, with uncancelled owned rollback", async () => {
  const abort = new AbortController(), runner = new FakeIncus(); runner.exists = true;
  const run = runner.run.bind(runner);
  vi.spyOn(runner, "run").mockImplementation(async (command, args, options) => {
    if (args.includes("exec") && args.at(-1) === "true") abort.abort(new Error("caller cancelled"));
    if (args.includes("stop")) expect(options?.signal?.aborted).toBe(false);
    return run(command, args, options);
  });
  const machines = new IncusMachines(config, runner, { apply: async () => {}, verify: async () => {} }, runner, undefined, abort.signal);
  await expect(machines.startReady(workspace())).rejects.toThrow("caller cancelled");
  expect(runner.running).toBe(false); expect(runner.calls.some((args) => args.includes("docker"))).toBe(false);
});

it("rejects pre-aborted per-command options without launching and rejects late zero after caller cancellation", async () => {
  const deadline = new VmStartupDeadline(1000), runner = new FakeIncus(), run = vi.spyOn(runner, "run"), abort = new AbortController();
  try {
    abort.abort(new Error("already cancelled"));
    expect(() => deadline.runner(runner).run("incus", [], { signal: abort.signal })).toThrow("already cancelled");
    expect(run).not.toHaveBeenCalled();
    const active = new AbortController();
    run.mockImplementation(async (command, args) => { active.abort(new Error("cancelled at exit")); return { command, args, stdout: "", stderr: "", exitCode: 0 }; });
    await expect(deadline.runner(runner).run("incus", [], { signal: active.signal })).rejects.toThrow("cancelled at exit");
  } finally { deadline.close(); }
});

it("cancels a real blocked subprocess instead of waiting indefinitely for a readiness result", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dim-vm-deadline-")), pid = path.join(root, "pid");
  const deadline = new VmStartupDeadline(1000);
  try {
    await expect(deadline.runner(new ProcessRunner()).run(process.execPath, ["-e", 'require("node:fs").writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)', pid]))
      .rejects.toThrow(/deadline/);
    const child = Number(await readFile(pid, "utf8"));
    expect(() => process.kill(child, 0)).toThrow();
  } finally { deadline.close(); await rm(root, { recursive: true, force: true }); }
}, 10_000);

it("combines per-budget caller cancellation and rejects a late successful privileged result", async () => {
  const deadline = new VmStartupDeadline(1000), abort = new AbortController();
  const apply = vi.fn<VmBudget["apply"]>(async (_identity, _resources, options) => {
    expect(options?.signal?.aborted).toBe(false);
    abort.abort(new Error("budget caller cancelled"));
    expect(options?.signal?.aborted).toBe(true);
  });
  try {
    await expect(deadline.budget({ apply, verify: async () => {} }).apply({ instance: "owned", pid: 1 }, workspace().resources, { signal: abort.signal }))
      .rejects.toThrow("budget caller cancelled");
    expect(apply).toHaveBeenCalledOnce();
    expect(() => deadline.budget({ apply, verify: async () => {} }).apply({ instance: "owned", pid: 1 }, workspace().resources, { signal: abort.signal }))
      .toThrow("budget caller cancelled");
    expect(apply).toHaveBeenCalledOnce();
  } finally { deadline.close(); }
});

it("reconnects only the exact TLS transport failure for agent and Docker probes without restarting the VM", async () => {
  const runner = new FakeIncus(); runner.exists = true;
  const run = runner.run.bind(runner), failed = new Set<string>();
  vi.spyOn(runner, "run").mockImplementation(async (command, args, options) => {
    if (args.includes("exec")) {
      const probe = args.includes("docker") ? "docker" : args.at(-1) === "true" ? "agent" : undefined;
      if (probe && !failed.has(probe)) {
        failed.add(probe);
        return { command, args, stdout: "", stderr: "Error: local error: tls: bad record MAC\n", exitCode: 1 };
      }
    }
    return run(command, args, options);
  });
  const prepare = vi.fn(async () => {}), apply = vi.fn(async () => {}), finish = vi.fn(async () => {});
  await new IncusMachines(config, runner, { prepare, apply, verify: async () => {} }).startReady(workspace(), finish);
  expect([...failed]).toEqual(["agent", "docker"]); expect(finish).toHaveBeenCalledOnce();
  expect(prepare).toHaveBeenCalledOnce(); expect(apply).toHaveBeenCalledOnce();
  expect(runner.calls.filter(args => args[0] === "start")).toHaveLength(1);
  expect(runner.calls.some(args => args[0] === "stop")).toBe(false);
});

it("retains the last exact TLS failure on shared-budget expiry and independently rolls back", async () => {
  let now = 0, probes = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const runner = new FakeIncus(); runner.exists = true;
  const run = runner.run.bind(runner);
  vi.spyOn(runner, "run").mockImplementation(async (command, args, options) => {
    if (args.includes("docker")) {
      probes++; now += 350;
      return { command, args, stdout: "", stderr: "Error: local error: tls: bad record MAC\n", exitCode: 1 };
    }
    if (args.includes("stop")) expect(options?.signal?.aborted).toBe(false);
    return run(command, args, options);
  });
  const release = vi.fn(async () => {}), finish = vi.fn();
  const machines = new IncusMachines({ ...config, startupTimeoutMilliseconds: 1000 }, runner, { apply: async () => {}, verify: async () => {}, release });
  await expect(machines.startReady(workspace(), finish)).rejects.toThrow(/deadline.*guest Docker; last Incus readiness probe failed \(exit 1\): Error: local error: tls: bad record MAC/);
  expect(probes).toBe(3); expect(finish).not.toHaveBeenCalled(); expect(runner.running).toBe(false);
  expect(release).toHaveBeenCalledOnce();
});

it("does not turn a cancelled reconnect's late zero into readiness success", async () => {
  const abort = new AbortController(), runner = new FakeIncus(); runner.exists = true;
  const run = runner.run.bind(runner); let probes = 0;
  vi.spyOn(runner, "run").mockImplementation(async (command, args, options) => {
    if (args.includes("docker")) {
      probes++;
      if (probes === 1) return { command, args, stdout: "", stderr: "Error: local error: tls: bad record MAC", exitCode: 1 };
      abort.abort(new Error("cancelled reconnect"));
    }
    if (args.includes("stop")) expect(options?.signal?.aborted).toBe(false);
    return run(command, args, options);
  });
  const finish = vi.fn();
  await expect(new IncusMachines(config, runner, { apply: async () => {}, verify: async () => {} }, runner, undefined, abort.signal)
    .startReady(workspace(), finish)).rejects.toThrow("cancelled reconnect");
  expect(probes).toBe(2); expect(finish).not.toHaveBeenCalled(); expect(runner.running).toBe(false);
});

it.each([
  { exitCode: 2, stderr: "Error: local error: tls: bad record MAC" },
  { exitCode: 1, stderr: "Error: local error: tls: bad record MAC\nunknown detail" },
  { exitCode: 1, stderr: "Error: remote error: tls: bad record MAC" },
  { exitCode: 1, stderr: "Error: tls: failed to verify certificate: x509: certificate signed by unknown authority" },
  { exitCode: 1, stderr: "Error: Failed to connect to agent: tls: failed to verify certificate: x509: certificate signed by unknown authority" },
  { exitCode: 1, stderr: "Error: Failed to connect to agent: authentication failed" },
  { exitCode: 1, stderr: "Error: agent not connected: permission denied" }
])("rejects an unrecognized readiness failure without retry: $exitCode / $stderr", async failure => {
  const runner = new FakeIncus(); runner.exists = true;
  const run = runner.run.bind(runner); let probes = 0;
  vi.spyOn(runner, "run").mockImplementation(async (command, args, options) => {
    if (args.includes("docker")) { probes++; return { command, args, stdout: "", ...failure }; }
    return run(command, args, options);
  });
  await expect(new IncusMachines(config, runner, { apply: async () => {}, verify: async () => {} }).startReady(workspace()))
    .rejects.toThrow(`VM guest Docker readiness failed: Incus exit ${failure.exitCode}: ${failure.stderr}`);
  expect(probes).toBe(1); expect(runner.running).toBe(false);
});

const recordedOperationEof = 'Error: Get "http://unix.socket/1.0/operations/b547f1ed-7abd-46ab-8b2f-337d0d4d3203?project=dim": EOF';

it.each([
  { probe: "agent", exitCode: 1, stderr: recordedOperationEof },
  { probe: "Docker", exitCode: 255, stderr: "Error: local error: tls: bad record MAC" }
])("reconnects the recorded $probe transport failure until an actual zero within one startup", async failure => {
  const runner = new FakeIncus(); runner.exists = true;
  const run = runner.run.bind(runner); let probes = 0;
  vi.spyOn(runner, "run").mockImplementation(async (command, args, options) => {
    if ((failure.probe === "agent" && args.at(-1) === "true") || (failure.probe === "Docker" && args.includes("docker"))) {
      probes++;
      if (probes === 1) return { command, args, stdout: "", exitCode: failure.exitCode, stderr: failure.stderr };
    }
    return run(command, args, options);
  });
  const finish = vi.fn();
  await new IncusMachines(config, runner, { apply: async () => {}, verify: async () => {} }).startReady(workspace(), finish);
  expect(probes).toBe(2); expect(finish).toHaveBeenCalledOnce();
  expect(runner.calls.filter(args => args[0] === "start")).toHaveLength(1);
  expect(runner.calls.some(args => args[0] === "stop")).toBe(false);
});

it.each([
  { exitCode: 255, stderr: recordedOperationEof, stdout: "" },
  { exitCode: 1, stderr: recordedOperationEof.replace("unix.socket", "example.test"), stdout: "" },
  { exitCode: 1, stderr: recordedOperationEof.replace("project=dim", "project=other"), stdout: "" },
  { exitCode: 1, stderr: recordedOperationEof.replace("project=dim", "project=dim&other=1"), stdout: "" },
  { exitCode: 1, stderr: recordedOperationEof.replace("b547f1ed-7abd-46ab-8b2f-337d0d4d3203", "not-an-operation"), stdout: "" },
  { exitCode: 1, stderr: recordedOperationEof + "\npermission denied", stdout: "" },
  { exitCode: 1, stderr: recordedOperationEof.replace(": EOF", ": unexpected EOF"), stdout: "" },
  { exitCode: 1, stderr: recordedOperationEof, stdout: "guest application output" },
  { exitCode: 255, stderr: "Error: local error: tls: bad record MAC", stdout: "guest application output" }
])("fails closed outside the recorded transport signature: $exitCode / $stderr / $stdout", async failure => {
  const runner = new FakeIncus(); runner.exists = true;
  const run = runner.run.bind(runner); let probes = 0;
  vi.spyOn(runner, "run").mockImplementation(async (command, args, options) => {
    if (args.at(-1) === "true") { probes++; return { command, args, ...failure }; }
    return run(command, args, options);
  });
  await expect(new IncusMachines(config, runner, { apply: async () => {}, verify: async () => {} }).startReady(workspace()))
    .rejects.toThrow(`VM guest readiness failed: Incus exit ${failure.exitCode}: ${failure.stderr}`);
  expect(probes).toBe(1); expect(runner.running).toBe(false);
});

it.each([
  { exitCode: 1, stderr: recordedOperationEof },
  { exitCode: 255, stderr: "Error: local error: tls: bad record MAC" }
])("retains recorded transport exit $exitCode at the original shared deadline and cleans up independently", async failure => {
  let now = 0, probes = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const runner = new FakeIncus(); runner.exists = true;
  const run = runner.run.bind(runner);
  vi.spyOn(runner, "run").mockImplementation(async (command, args, options) => {
    if (args.at(-1) === "true") { probes++; now += 350; return { command, args, stdout: "", ...failure }; }
    if (args.includes("stop")) expect(options?.signal?.aborted).toBe(false);
    return run(command, args, options);
  });
  const release = vi.fn(async () => {}), finish = vi.fn();
  await expect(new IncusMachines({ ...config, startupTimeoutMilliseconds: 1000 }, runner, { apply: async () => {}, verify: async () => {}, release })
    .startReady(workspace(), finish)).rejects.toThrow(`last Incus readiness probe failed (exit ${failure.exitCode}): ${failure.stderr}`);
  expect(probes).toBe(3); expect(finish).not.toHaveBeenCalled(); expect(runner.running).toBe(false); expect(release).toHaveBeenCalledOnce();
});

it("cancels a recorded operation reconnect without accepting its late zero or cancelling rollback", async () => {
  const abort = new AbortController(), runner = new FakeIncus(); runner.exists = true;
  const run = runner.run.bind(runner); let probes = 0;
  vi.spyOn(runner, "run").mockImplementation(async (command, args, options) => {
    if (args.at(-1) === "true") {
      if (++probes === 1) return { command, args, stdout: "", stderr: recordedOperationEof, exitCode: 1 };
      abort.abort(new Error("operation reconnect cancelled"));
    }
    if (args.includes("stop")) expect(options?.signal?.aborted).toBe(false);
    return run(command, args, options);
  });
  const finish = vi.fn();
  await expect(new IncusMachines(config, runner, { apply: async () => {}, verify: async () => {} }, runner, undefined, abort.signal)
    .startReady(workspace(), finish)).rejects.toThrow("operation reconnect cancelled");
  expect(probes).toBe(2); expect(finish).not.toHaveBeenCalled(); expect(runner.running).toBe(false);
});
