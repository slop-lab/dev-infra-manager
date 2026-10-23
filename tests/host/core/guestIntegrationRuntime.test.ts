import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import { ProcessRunner } from "../../../packages/host/core/src/runner.js";
import { MissingRecordError } from "../../../packages/host/core/src/errors.js";
import { ContainerWorkspaceRuntime } from "../../../packages/host/core/src/workspace/runtime.js";
import { WorkspaceService } from "../../../packages/host/core/src/workspace/service.js";
import { WorkspaceStore } from "../../../packages/host/core/src/workspace/store.js";
import { deployGuestIntegration } from "../../../packages/host/core/src/workspace/guestIntegration.js";
import { workspaceGuestAssets } from "../../../packages/host/core/src/workspace/guestAssets.js";
import { createWorkspaceAgentServer } from "../../../packages/host/core/src/application/workspace-agent.js";
import { loadHostPlugins } from "../../../packages/host/core/src/application/host-plugins.js";

const image = process.env.DIM_GUEST_INTEGRATION_IMAGE;

describe("guest integrations in an ordinary disposable workspace", () => {
  it.skipIf(!image)("delivers without repository configuration, repairs after recreation and targets only one nested container", async () => {
    if (!image) throw new Error("provide a reviewed local DIM_GUEST_INTEGRATION_IMAGE");
    const root = await mkdtemp(join(tmpdir(), "dim-guest-integration-runtime-"));
    const runner = new ProcessRunner(), runtime = new ContainerWorkspaceRuntime(runner);
    const store = new WorkspaceStore(join(root, "state"));
    const service = new WorkspaceService(store, runtime, async ({ destination }) => {
      await mkdir(destination, { recursive: true });
      const initialized = await runner.run("git", ["init", "--initial-branch=main", destination]);
      expect(initialized.exitCode, initialized.stderr).toBe(0);
      await writeFile(join(destination, "README.md"), "Ordinary repository without .dim configuration.\n");
      return { url: "file:///disposable-fixture", ref: "main", commit: "a".repeat(40) };
    });
    const name = `guest-integration-${randomUUID().slice(0, 8)}`;
    let bridge: Server | undefined;
    try {
      const workspace = await service.create({ name, source: { url: "file:///disposable-fixture" }, image });
      const context = { service, workspace, signal: AbortSignal.timeout(180_000) };
      const integration = { name: "fixture", files: [{ path: ".config/fixture/client.json", contents: '{"ready":true}', mode: 0o600 as const }] };
      const execute = async (command: string[]) => {
        let output = "", error = "";
        const status = await service.exec(name, command, { workspaceId: workspace.id, signal: context.signal,
          stdout: new Writable({ write(chunk, _encoding, done) { output += String(chunk); done(); } }),
          stderr: new Writable({ write(chunk, _encoding, done) { error += String(chunk); done(); } }) });
        return { status, output, error };
      };
      const pluginHome = join(root, "plugins");
      const enabled = ["agent-tools", "external-urls"];
      await mkdir(join(pluginHome, "node_modules/@slop-lab"), { recursive: true });
      for (const plugin of enabled) await symlink(new URL(`../../../../packages/host/plugins/${plugin.replace(/^host-/, "")}`, import.meta.url).pathname,
        join(pluginHome, "node_modules/@slop-lab", `dim-host-plugin-${plugin.replace(/^host-/, "")}`));
      const manifest = (plugins: string[]) => JSON.stringify({ schemaVersion: 1, plugins: plugins.map((name) => `@slop-lab/dim-host-plugin-${name.replace(/^host-/, "")}`) });
      await writeFile(join(pluginHome, "plugins.json"), manifest(enabled));
      vi.stubEnv("DIM_PLUGIN_HOME", pluginHome);
      vi.stubEnv("DIM_EXTERNAL_URL_CONFIG", join(root, "unconfigured-ingress.json"));
      const host = await runtime.hostGateway(workspace);
      const hostContext = { ...context, runner, cleanupRunner: runner, runtime, store, stateRoot: store.root };
      bridge = createWorkspaceAgentServer({ workspaceName: name, workspaceId: workspace.id, stateRoot: store.root,
        host, token: "a".repeat(43), generation: "physical-fixture" }, hostContext);
      await new Promise<void>((resolve) => bridge!.listen(0, host, resolve));
      const address = bridge.address();
      if (!address || typeof address === "string") throw new Error("expected a private TCP bridge");
      await deployGuestIntegration(context, { name: "workspace-client", files: await Promise.all(workspaceGuestAssets()
        .filter(({ name }) => name === "dim-workspace" || name === "dim-nproc")
        .map(async ({ name, sourcePath }) => ({ path: `.local/bin/${name}`, contents: await readFile(sourcePath), mode: 0o700 as const }))) });
      await deployGuestIntegration(context, { name: "workspace-connection", files: [{ path: ".config/dim/workspace.json",
        contents: JSON.stringify({ endpoint: `http://${host}:${address.port}`, workspaceId: workspace.id, token: "a".repeat(43) }) }] });
      for (const plugin of await loadHostPlugins()) await plugin.workspaceReady?.(workspace, hostContext);
      expect((await execute(["bash", "-c", "command -v dim-workspace"])).output.trim()).toBe("/home/dim/.local/bin/dim-workspace");
      const discovered = await execute(["dim-workspace", "plugins"]);
      expect(discovered.status, discovered.error).toBe(0);
      expect(JSON.parse(discovered.output).plugins.map((plugin: { name: string; state: string }) => [plugin.name, plugin.state]))
        .toEqual([["agent-tools", "unconfigured"], ["external-urls", "unconfigured"]]);
      expect((await execute(["dim-expose", "--help"])).output).toContain("Usage: dim-expose");
      await writeFile(join(pluginHome, "plugins.json"), manifest(["agent-tools"]));
      expect(JSON.parse((await execute(["dim-workspace", "plugins"])).output).plugins.map((plugin: { name: string }) => plugin.name)).toEqual(["agent-tools"]);
      await deployGuestIntegration(context, integration);
      const probe = ["node", "-e", 'const fs=require("fs"),p=process.env.HOME+"/.config/fixture/client.json";console.log(JSON.stringify({text:fs.readFileSync(p,"utf8"),mtime:fs.statSync(p).mtimeMs}))'];
      const first = await execute(probe); expect(first.status, first.error).toBe(0);
      await deployGuestIntegration(context, integration);
      expect((await execute(probe)).output).toBe(first.output);
      expect((await execute(["test", "!", "-e", "/workspace/.dim"])).status).toBe(0);
      expect((await execute(["rm", "/home/dim/.config/fixture/client.json"])).status).toBe(0);
      await service.recreate(name, workspace.id);
      await deployGuestIntegration(context, integration);
      expect(JSON.parse((await execute(probe)).output).text).toBe('{"ready":true}');
      // The nested fixture uses reviewed guest binaries, with no registry or host mount.
      const prepared = await execute(["bash", "-ceu", nestedFixture]);
      expect(prepared.status, prepared.error).toBe(0);
      await deployGuestIntegration(context, { ...integration, target: { container: "selected", user: "dim" } });
      const selected = await execute(["docker", "exec", "--user", "dim", "selected", ...probe]);
      expect(selected.status, selected.error).toBe(0);
      expect(JSON.parse(selected.output).text).toBe('{"ready":true}');
      const untouched = await execute(["docker", "exec", "--user", "dim", "untouched", "node", "-e",
        'if(require("fs").existsSync(process.env.HOME+"/.config/fixture/client.json"))process.exit(1)']);
      expect(untouched.status, untouched.error).toBe(0);
      await expect(deployGuestIntegration({ ...context, workspace: { ...workspace, id: randomUUID() } }, integration)).rejects.toThrow();
    } finally {
      if (bridge) { bridge.closeAllConnections(); await new Promise<void>((resolve) => bridge!.close(() => resolve())); }
      vi.unstubAllEnvs();
      const remaining = await store.read(name).catch((error: unknown) => {
        if (error instanceof MissingRecordError) return undefined;
        throw error;
      });
      if (remaining) await service.discard(name, remaining.id);
      await rm(root, { recursive: true, force: true });
    }
  }, 240_000);
});

const nestedFixture = String.raw`
rootfs=$(mktemp -d)
trap 'rm -rf "$rootfs"' EXIT
node_binary=$(readlink -f "$(command -v node)")
mkdir -p "$rootfs/etc" "$rootfs/home/dim"
cp --parents -L "$node_binary" "$rootfs"
while IFS= read -r library; do cp --parents -L "$library" "$rootfs"; done < <(ldd "$node_binary" | awk '{for(i=1;i<=NF;i++)if($i ~ /^\//)print $i}')
printf 'root:x:0:0:root:/root:/bin/sh\ndim:x:1000:1000:dim:/home/dim:/bin/sh\n' > "$rootfs/etc/passwd"
printf 'root:x:0:\ndim:x:1000:\n' > "$rootfs/etc/group"
tar --create --file - --directory "$rootfs" . | docker import - dim-guest-client-fixture:local >/dev/null
for container in selected untouched; do
 docker run --detach --name "$container" --user 0 --env HOME=/home/dim --entrypoint "$node_binary" dim-guest-client-fixture:local -e 'require("fs").chownSync("/home/dim",1000,1000);setInterval(()=>{},1000)' >/dev/null
done
`;
