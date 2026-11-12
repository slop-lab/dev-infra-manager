import { execFile, spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
const execute = promisify(execFile);
export const workspaceId = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
export async function taskSurfaceFixture() {
  const root = await mkdtemp(join(tmpdir(), "dim-task-surface-")), home = join(root, "home"), helper = join(home, ".local/share/dim-agent-tools"), bin = join(home, "bin");
  const source = fileURLToPath(new URL("../../../../packages/host/plugins/agent-tools/src/", import.meta.url));
  const env = { ...process.env, HOME: home, XDG_STATE_HOME: join(home, ".local/state"), XDG_CONFIG_HOME: join(home, ".config"), OMO_PROFILE: undefined, OCX_PROFILE: undefined, OPENCODE_CONFIG: undefined, OPENCODE_CONFIG_DIR: undefined, OPENCODE_CONFIG_CONTENT: undefined, PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin` };
  await mkdir(helper, { recursive: true }); await mkdir(bin); await mkdir(join(home, ".config/dim"), { recursive: true });
  await writeFile(join(home, ".config/dim/workspace.json"), JSON.stringify({ workspaceId }), { mode: 0o600 });
  await cp(join(source, "execution"), join(helper, "execution"), { recursive: true }); await writeFile(join(helper, "execution/package.json"), '{"type":"module"}\n');
  for (const name of ["opencode-server.bash", "opencode-service.bash", "opencode-runtime.bash", "opencode-team-metadata.mjs", "omo-model-availability.mjs"]) await cp(join(source, "assets", name), join(helper, name));
  const registry = fileURLToPath(new URL("../../../../packages/host/core/src/workspace-image-assets/dim-workspace.mjs", import.meta.url));
  await writeFile(join(bin, "dim-workspace"), `#!/bin/sh\nexec '${process.execPath}' '${registry}' "$@"\n`, { mode: 0o700 });
  const probe = createServer(); await new Promise<void>(resolve => probe.listen(0, "127.0.0.1", resolve)); const address = probe.address(); if (!address || typeof address === "string") throw Error("Missing task surface port"); await new Promise<void>(resolve => probe.close(() => resolve()));
  const childEnv = { ...env, OPENCODE_WEB_PORT: String(address.port) }, launcher = join(helper, "opencode-server.bash");
  await writeFile(join(bin, "opencode"), `#!${process.execPath}
// @ts-check
const http=require('node:http'),fs=require('node:fs'),cp=require('node:child_process'),path=require('node:path');
if(process.argv.includes('--version')){console.log('1.18.31');process.exit(0);}
if(process.argv.includes('models')){console.log('openai/test-model\\n{\\n "id": "test-model"\\n}');process.exit(0);}
const home=process.env.HOME,auth='Basic '+Buffer.from(process.env.OPENCODE_SERVER_USERNAME+':'+process.env.OPENCODE_SERVER_PASSWORD).toString('base64');
http.createServer((q,s)=>{if(q.headers.authorization!==auth){s.writeHead(401);s.end('{}');return;}let source='';q.on('data',c=>source+=c);q.on('end',()=>{const url=new URL(q.url,'http://127.0.0.1'),body=source?JSON.parse(source):null;
if(url.pathname==='/global/health'){s.end('{"healthy":true}');return;}
const held=cp.spawnSync('flock',['--exclusive','--nonblock',path.join(process.env.XDG_STATE_HOME,'opencode-web/launch.lock'),'true']).status===1;
fs.appendFileSync(home+'/task-http.jsonl',JSON.stringify({path:url.pathname,method:q.method,body,held,directory:url.searchParams.get('directory')})+'\\n');
if(q.method==='POST'&&url.pathname.endsWith('/prompt_async')){if(fs.existsSync(home+'/drop-response')){q.socket.destroy();return;}s.writeHead(204);s.end();return;}
s.end(JSON.stringify({id:'ses_fixture',directory:home}));});}).listen(Number(process.env.OPENCODE_WEB_PORT),'127.0.0.1');
`, { mode: 0o700 });
  const run = async (operation: string, value: unknown) => new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [join(helper, "execution/taskCli.ts"), operation, "--input-stdin", "--json"], { env: childEnv, cwd: home, stdio: ["pipe", "pipe", "pipe"], signal: AbortSignal.timeout(12_000) });
    let stdout = "", stderr = ""; child.stdout.on("data", chunk => { stdout += chunk.toString(); }); child.stderr.on("data", chunk => { stderr += chunk.toString(); }); child.stdin.on("error", reject); child.once("error", reject); child.once("close", code => resolve({ code: code ?? 1, stdout, stderr })); child.stdin.end(JSON.stringify(value));
  });
  try { await execute("bash", [launcher, "start", "--json"], { env: childEnv, cwd: home, timeout: 12_000 }); }
  catch (error) { await execute("bash", [launcher, "stop", "--json"], { env: childEnv, cwd: home, timeout: 12_000 }).catch(() => {}); await rm(root, { recursive: true, force: true }); throw error; }
  return { home, run, async calls() { try { return (await readFile(join(home, "task-http.jsonl"), "utf8")).trim().split("\n").filter(Boolean).map((row): unknown => JSON.parse(row)); } catch { return []; } }, async drop() { await writeFile(join(home, "drop-response"), "drop"); }, async breakIdentity() { await writeFile(join(helper, "opencode-team-metadata.mjs"), "process.exitCode=2;\n"); }, async cleanup() { await execute("bash", [launcher, "stop", "--json"], { env: childEnv, cwd: home, timeout: 12_000 }); await rm(root, { recursive: true, force: true }); } };
}
