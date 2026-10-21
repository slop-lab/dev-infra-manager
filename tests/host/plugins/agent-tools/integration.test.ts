import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ContainerWorkspaceRuntime, ProcessRunner, WorkspaceService, WorkspaceStore } from "@slop-lab/dim-host-core/workspace";
import { type WorkspaceHostPluginContext } from "@slop-lab/dim-host-core/plugin-api";
import { hostPlugin } from "../../../../packages/host/plugins/agent-tools/src/index.js";
import { workspaceRecord } from "../../../support/workspaceFixture.js";

afterEach(() => { vi.restoreAllMocks(); });
it("prepares helpers without repository configuration or npm installation and discovers actual tool setup state", async () => {
  const root = await mkdtemp(join(tmpdir(), "dim-tools-integration-")), home = join(root, "home");
  try {
    await mkdir(home, { mode: 0o700 });
    const workspace = workspaceRecord(), store = new WorkspaceStore(join(root, "host")); await store.write(workspace);
    const runner = new ProcessRunner(), service = new WorkspaceService(store, new ContainerWorkspaceRuntime(runner), async () => { throw new Error("unexpected repository acquisition"); });
    const context: WorkspaceHostPluginContext = { runner, cleanupRunner: runner, store, service, stateRoot: store.root, signal: new AbortController().signal };
    let launches = 0;
    vi.spyOn(service, "exec").mockImplementation(async (name, args, options) => {
      expect(name).toBe(workspace.name); expect(options?.workspaceId).toBe(workspace.id);
      if (args[0] !== "node") { expect(args).toEqual(["dim-agent", "codex"]); expect((await stat(join(home, ".local/bin/dim-agent"))).isFile()).toBe(true); launches++; return 0; }
      const chunks: Buffer[] = []; if (options?.stdin) for await (const chunk of options.stdin) chunks.push(Buffer.from(chunk));
      return new Promise<number>((resolve, reject) => {
        const child = spawn(process.execPath, args.slice(1), { env: { ...process.env, HOME: home }, stdio: ["pipe", "pipe", "pipe"] });
        child.stdout.resume(); child.stderr.resume(); child.once("error", reject); child.once("close", (code) => resolve(code ?? 1)); child.stdin.end(Buffer.concat(chunks));
      });
    });
    await hostPlugin.workspaceReady!(workspace, context);
    const helper = join(home, ".local/bin/dim-agent"), setup = join(home, ".local/bin/dim-tools-setup");
    expect((await stat(helper)).mode & 0o777).toBe(0o700);
    expect((await stat(join(home, ".local/share/dim-agent-tools/opencode-runtime.bash"))).mode & 0o777).toBe(0o700);
    expect(await readFile(setup, "utf8")).toContain("tool-setup.bash");
    expect(await hostPlugin.guest!.inspect!(workspace, context)).toMatchObject({ state: "unconfigured", message: expect.stringContaining("no npm tools were installed automatically") });
    const inode = (await stat(helper)).ino;
    await hostPlugin.workspaceReady!(workspace, context); expect((await stat(helper)).ino).toBe(inode);
    await unlink(helper); await hostPlugin.run!(["tools", "run", workspace.name, "codex"], context);
    expect(launches).toBe(1); expect(await readFile(helper, "utf8")).toContain("dim-agent:");
    const executable = join(home, ".local/bin/opencode");
    await writeFile(executable, "#!/bin/sh\nprintf 'tool fixture\\n'\n", { mode: 0o700 });
    await mkdir(join(home, ".local/state/dim-tools"), { recursive: true });
    await writeFile(join(home, ".local/state/dim-tools/opencode.json"), JSON.stringify({ tool: "opencode", version: "1.18.31", executable }), { mode: 0o600 });
    expect(await hostPlugin.guest!.inspect!(workspace, context)).toMatchObject({ state: "ready" });
    await unlink(executable); expect(await hostPlugin.guest!.inspect!(workspace, context)).toMatchObject({ state: "unconfigured" });
  } finally { await rm(root, { recursive: true, force: true }); }
});
