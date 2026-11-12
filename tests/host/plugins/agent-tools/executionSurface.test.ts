import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const execute = promisify(execFile);
const source = fileURLToPath(new URL("../../../../packages/host/plugins/agent-tools/src/", import.meta.url));

it("drives copied HOME-layout ESM helpers against an owned authenticated listener with busy subagents and unavailable teams", async () => {
  const root = await mkdtemp(join(tmpdir(), "dim-execution-surface-"));
  const home = join(root, "home"), helper = join(home, ".local/share/dim-agent-tools"), bin = join(home, "bin");
  const env = { ...process.env, HOME: home, XDG_STATE_HOME: join(home, ".local/state"), XDG_CONFIG_HOME: join(home, ".config"), OMO_PROFILE: undefined, OCX_PROFILE: undefined, OPENCODE_CONFIG: undefined, OPENCODE_CONFIG_DIR: undefined, OPENCODE_CONFIG_CONTENT: undefined, PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin` };
  const launcher = join(helper, "opencode-server.bash"), cli = join(helper, "execution/cli.ts");
  const run = (args: string[]) => execute(process.execPath, [cli, ...args], { env, cwd: home, timeout: 12_000 });
  try {
    await mkdir(helper, { recursive: true }); await mkdir(bin);
    await mkdir(join(home, ".config/dim"), { recursive: true });
    await writeFile(join(home, ".config/dim/workspace.json"), "{}", { mode: 0o600 });
    const registry = fileURLToPath(new URL("../../../../packages/host/core/src/workspace-image-assets/dim-workspace.mjs", import.meta.url));
    await writeFile(join(bin, "dim-workspace"), `#!/bin/sh\nexec '${process.execPath}' '${registry}' "$@"\n`, { mode: 0o700 });
    await cp(join(source, "execution"), join(helper, "execution"), { recursive: true });
    await writeFile(join(helper, "execution/package.json"), '{"type":"module"}\n');
    for (const name of ["opencode-server.bash", "opencode-service.bash", "opencode-runtime.bash", "opencode-team-metadata.mjs", "omo-model-availability.mjs"]) await cp(join(source, "assets", name), join(helper, name));
    const probe = createServer(); await new Promise<void>(resolve => probe.listen(0, "127.0.0.1", resolve));
    const address = probe.address(); if (!address || typeof address === "string") throw Error("Missing fixture port");
    await new Promise<void>(resolve => probe.close(() => resolve()));
    Object.assign(env, { OPENCODE_WEB_PORT: String(address.port) });
    const values = {
      "/experimental/tool/ids": ["team_list"],
      "/session/status": { ses_parent: { type: "idle" }, ses_child: { type: "busy" } },
      "/session": [{ id: "ses_parent" }, { id: "ses_child", parentID: "ses_parent" }],
      "/session/ses_parent": { id: "ses_parent" },
      "/session/ses_parent/children": [{ id: "ses_child", parentID: "ses_parent" }],
      "/session/ses_child/children": [], "/question": [], "/permission": [],
      "/session/ses_parent/message": [{ info: { role: "assistant" }, parts: [{ type: "text", text: "PRIVATE-prompt" }] }],
      "/session/ses_child/message": [{ info: { role: "assistant" }, parts: [{ type: "tool", tool: "bash", state: { status: "running", input: "PRIVATE-input", output: "PRIVATE-output" } }] }]
    };
    await writeFile(join(bin, "opencode"), `#!${process.execPath}
// @ts-check
const http=require('node:http'),fs=require('node:fs');
if(process.argv.includes('--version')){console.log('1.18.31');process.exit(0);}
if(process.argv.includes('models')){console.log('openai/test-model\\n{\\n "id": "test-model"\\n}');process.exit(0);}
const values=${JSON.stringify(values)},auth='Basic '+Buffer.from(process.env.OPENCODE_SERVER_USERNAME+':'+process.env.OPENCODE_SERVER_PASSWORD).toString('base64');
http.createServer((q,s)=>{fs.appendFileSync(process.env.HOME+'/requests','1');s.statusCode=q.headers.authorization===auth?200:401;s.end(s.statusCode===401?'{}':JSON.stringify(values[new URL(q.url,'http://127.0.0.1').pathname]??{healthy:true}));}).listen(Number(process.env.OPENCODE_WEB_PORT),'127.0.0.1');
`, { mode: 0o700 });
    expect(JSON.parse((await execute("bash", [launcher, "start", "--json"], { env, cwd: home, timeout: 12_000 })).stdout).state).toBe("running");
    const inspected = await run(["status", "--session", "ses_parent", "--json"]);
    expect(JSON.parse(inspected.stdout)).toMatchObject({ evidence: { state: "active", activeChildren: 1, totalChildren: null, teams: "unknown", discovery: "partial", completion: "not-assessed", sessions: [{ activity: "idle" }, { activity: "active" }] } });
    expect(inspected.stdout).not.toContain("PRIVATE");
    expect((await run(["status", "--session", "ses_parent"])).stdout).toContain("1 active subagents, total unknown; teams unknown");
    const waited = JSON.parse((await run(["wait", "--session", "ses_parent", "--timeout-seconds", "1", "--json"])).stdout);
    expect(waited.outcome).toBe("timed-out"); expect(waited.observations).toBeLessThanOrEqual(1);
    if (waited.evidence === null) expect(waited.revision).toBeNull(); else expect(waited.evidence).toMatchObject({ state: "active", teams: "unknown" });
    const before = await readFile(join(home, "requests"), "utf8");
    await expect(run(["status", "--session", "ses_parent", "--origin", "http://foreign.invalid"])).rejects.toMatchObject({ code: 1 });
    expect((await run(["--help"])).stdout).toContain("usage:");
    expect(await readFile(join(home, "requests"), "utf8")).toBe(before);
  } finally { await execute("bash", [launcher, "stop", "--json"], { env, cwd: home, timeout: 12_000 }).catch(() => {}); await rm(root, { recursive: true, force: true }); }
});
