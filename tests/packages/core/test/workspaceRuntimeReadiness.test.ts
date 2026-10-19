import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ContainerWorkspaceRuntime, ProcessRunner, workspaceRuntimeResources, type RunOptions, type StreamingCommandRunner } from "@slop-lab/dim-core/workspace";
import type { CommandResult } from "@slop-lab/dim-core";
import { workspaceRecord } from "../../../support/workspaceFixture.js";

it.each(["missing", "old process", "old namespace"])("waits for current-boot completion despite an already available engine: %s", async (previous) => {
  const root = await mkdtemp(join(tmpdir(), "dim-boot-readiness-"));
  try {
    const processes = new ProcessRunner();
    const identity = (await processes.run("sh", ["-c", `printf '%s %s' "$(awk '{print $22}' /proc/1/stat)" "$(readlink /proc/self/ns/pid)"`])).stdout;
    const marker = join(root, "ready"), engineCalls = join(root, "engine-calls");
    if (previous !== "missing") await writeFile(marker, previous === "old process" ? `0 ${identity.split(" ")[1]}` : `${identity.split(" ")[0]} pid:[0]`);
    await writeFile(join(root, "docker"), `#!/bin/sh\nprintf engine-ready >> '${engineCalls}'\n`, { mode: 0o700 });
    const runner = new ReadinessRunner(processes, marker, root, async () => { await writeFile(marker, identity); });
    await new ContainerWorkspaceRuntime(runner).start(workspaceRecord());
    expect(runner.probes).toBe(2);
    expect(await readFile(engineCalls, "utf8")).toBe("engine-ready");
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("reports the entrypoint failure when the engine answers before SSH boot fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "dim-boot-failed-"));
  try {
    const runner = new ReadinessRunner(new ProcessRunner(), join(root, "missing"), root, async () => { runner.running = false; });
    await expect(new ContainerWorkspaceRuntime(runner).start(workspaceRecord())).rejects.toThrow(/stopped during boot: SSH configuration invalid/);
    expect(runner.probes).toBe(1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

class ReadinessRunner implements StreamingCommandRunner {
  probes = 0;
  running = true;
  constructor(private readonly processes: ProcessRunner, private readonly marker: string, private readonly bin: string, private readonly firstProbe: () => Promise<void>) {}
  async run(command: string, args: string[], options?: RunOptions): Promise<CommandResult> {
    if (args[0] === "exec") {
      const shell = args[2], script = args[4];
      if (!shell || !script) throw new Error("missing boot probe");
      const result = await this.processes.run(shell, ["-c", script, "ready-probe", this.marker], { ...options, env: { ...process.env, PATH: `${this.bin}:${process.env.PATH}` } });
      if (++this.probes === 1) await this.firstProbe();
      return result;
    }
    const record = workspaceRecord(), r = workspaceRuntimeResources(record);
    const stdout = args[0] === "logs" ? "SSH configuration invalid" : JSON.stringify({ Id: "owned", Config: { Image: record.image, Labels: {
      "dim.managed": "true", "dim.workspace-id": record.id, "dim.resource": "container", "dim.workspace-schema": "10"
    } }, HostConfig: { Runtime: "sysbox-runc", Privileged: false, OomScoreAdj: 500, NetworkMode: r.network }, State: { Running: this.running },
    Mounts: ([["home", "/home/dim"], ["checkout", "/workspace"], ["docker", "/var/lib/docker"], ["tmp", "/mnt/dim-tmp"]] as const).map(([role, Destination]) => ({
      Type: "volume", RW: true, Destination, Name: r[role]
    })), NetworkSettings: { Networks: { [r.network]: {} } } });
    return { command, args, exitCode: 0, stdout, stderr: "" };
  }
  async runStreaming(): Promise<number> { throw new Error("readiness must not stream a host command"); }
}
