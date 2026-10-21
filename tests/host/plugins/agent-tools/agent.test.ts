import { execFile } from "node:child_process";
import { copyFile, chmod, mkdir, mkdtemp, readFile, rm, writeFile, symlink, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execute = promisify(execFile);
const agent = fileURLToPath(new URL("../../../../packages/host/plugins/agent-tools/src/assets/agent.mjs", import.meta.url));
const guest = fileURLToPath(new URL("../../../../packages/host/core/src/workspace-image-assets/dim-workspace.mjs", import.meta.url));

it("tool launch forwards exact arguments and registers tool-owned noninteractive continuation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dim-agent-tools-")), home = path.join(root, "home"), bin = path.join(home, ".local/bin");
  try {
    await mkdir(bin, { recursive: true }); await mkdir(path.join(home, ".local/state/dim-tools"), { recursive: true });
    const helpers = path.join(home, ".local/share/dim-agent-tools");
    await mkdir(helpers, { recursive: true });
    await copyFile(new URL("../../../../packages/host/plugins/agent-tools/src/assets/opencode-runtime.bash", import.meta.url), path.join(helpers, "opencode-runtime.bash"));
    for (const [tool, version] of [["codex", "0.156.1"], ["opencode", "1.18.31"]]) {
      if (!tool) throw new Error("missing tool");
      const executable = path.join(bin, tool);
      await copyFile(new URL("./fixtures/tool.mjs", import.meta.url), executable); await chmod(executable, 0o700);
      await writeFile(path.join(home, ".local/state/dim-tools", `${tool}.json`), JSON.stringify({ tool, version, executable }), { mode: 0o600 });
    }
    await writeFile(path.join(bin, "dim-workspace"), `#!${process.execPath}\n// @ts-check\nconst {spawnSync}=require('node:child_process');const r=spawnSync(process.execPath,[${JSON.stringify(guest)},...process.argv.slice(2)],{stdio:'inherit'});process.exit(r.status??1);`, { mode: 0o700 });
    const env = { ...process.env, NPM_CONFIG_CACHE: undefined, npm_config_cache: undefined, HOME: home, PATH: `${bin}:${process.env.PATH}`, DIM_WORKSPACE_TMPDIR: path.join(root, "temporary-volume") };
    const run = (...args: string[]) => execute(process.execPath, [agent, ...args], { cwd: home, env });
    const literal = "value;$(not-a-shell)";
    expect(JSON.parse((await run("codex", literal, "--host", "unchanged")).stdout).argv).toEqual([literal, "--host", "unchanged"]);
    await mkdir(path.join(home, ".config/dim"), { recursive: true });
    await writeFile(path.join(home, ".config/dim/opencode-launch.js"),
      'export async function prepareOpenCode(){return {OPENCODE_CONFIG_CONTENT:JSON.stringify({model:"dim-responses/reviewed"}),OMO_PROFILE:"dim-router"}}', { mode: 0o600 });
    const first = JSON.parse((await run("opencode", "--resume-on-restart", literal)).stdout);
    expect(first.argv).toEqual([literal]);
    expect(JSON.parse(first.opencodeConfig)).toEqual({ model: "dim-responses/reviewed" });
    expect(first.omoProfile).toBe("dim-router");
    expect(first.npmCache).toBe(path.join(home, ".local/share/workspace-user-setup/cache"));
    expect(first.npmCacheAlias).toBe(first.npmCache);
    expect((await stat(first.npmCache)).mode & 0o777).toBe(0o700);
    const customCache = path.join(root, "explicit-user-cache");
    const explicit = JSON.parse((await execute(process.execPath, [agent, "opencode", "run", "explicit"], {
      cwd: home, env: { ...env, NPM_CONFIG_CACHE: customCache }
    })).stdout);
    expect(explicit.npmCache).toBe(customCache); expect(explicit.npmCacheAlias).toBe(customCache);
    const unsafe = path.join(root, "cache-symlink"); await symlink(customCache, unsafe);
    await expect(execute(process.execPath, [agent, "opencode"], {
      cwd: home, env: { ...env, NPM_CONFIG_CACHE: unsafe }
    })).rejects.toThrow(/without a symlink/); expect(first.temporary).toBe(path.join(root, "temporary-volume/opencode"));
    const resumed = JSON.parse((await execute(process.execPath, [guest, "session", "resume"], { env, cwd: home })).stdout);
    expect(resumed.argv.slice(0, 2)).toEqual(["run", "--continue"]);
    expect(resumed.temporary).toBe(first.temporary);
    expect(resumed.opencodeConfig).toBe(first.opencodeConfig);
    expect(resumed.omoProfile).toBe(first.omoProfile);
    expect(resumed.npmCache).toBe(first.npmCache);
    await run("codex", "--resume-on-restart");
    const codex = JSON.parse((await execute(process.execPath, [guest, "session", "resume"], { env, cwd: home })).stdout);
    expect(codex.argv.slice(0, 4)).toEqual(["exec", "resume", "--last", expect.stringContaining("Continue the interrupted task")]);
    expect(await readFile(path.join(home, ".local/state/dim-tools/opencode.json"), "utf8")).toContain("1.18.31");
    await expect(run("other-tool")).rejects.toThrow(/usage: dim-agent/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
