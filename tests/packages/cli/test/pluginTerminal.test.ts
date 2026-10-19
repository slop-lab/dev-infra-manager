import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { promisify } from "node:util";
const execute = promisify(execFile);
const cli = fileURLToPath(new URL("../../../../core/packages/cli/src/cli.ts", import.meta.url));
const plugin = fileURLToPath(new URL("./fixtures/terminal-plugin.mjs", import.meta.url));
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

test("local and SSH optional plugin commands inherit the real operator PTY", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dim-plugin-tty-"));
  try {
    const bin = path.join(root, "bin"); await mkdir(bin);
    await writeFile(path.join(root, "plugins.json"), JSON.stringify({ schemaVersion: 1, plugins: [plugin] }));
    await writeFile(path.join(root, "package.json"), '{"private":true}');
    const env = { ...process.env, DIM_PLUGIN_HOME: root, DIM_STATE_ROOT: path.join(root, "state"), XDG_CONFIG_HOME: path.join(root, "config"), PATH: `${bin}:${process.env.PATH}` };
    const invocation = [process.execPath, "--import", import.meta.resolve("tsx"), cli];
    await writeFile(path.join(bin, "dim"), `#!/bin/sh\nexec ${invocation.map(quote).join(" ")} "$@"\n`); await chmod(path.join(bin, "dim"), 0o700);
    await writeFile(path.join(bin, "ssh"), `#!${process.execPath}\nconst {spawnSync}=require('node:child_process');if(process.argv[2]!=='-tt')throw Error('interactive SSH lost PTY allocation');if(!process.stdin.isTTY)throw Error('SSH input must inherit the real terminal');const r=spawnSync('/bin/sh',['-c',process.argv.at(-1)],{stdio:'inherit',env:process.env});process.exit(r.status??1);\n`); await chmod(path.join(bin, "ssh"), 0o700);
    await execute(process.execPath, [...invocation.slice(1), "host", "add", "devbox", "--ssh", "operator@host"], { env });
    for (const prefix of [[], ["--host", "devbox"]]) {
      const result = await execute("script", ["-q", "-e", "-c", [...invocation, ...prefix, "terminalprobe"].map(quote).join(" "), "/dev/null"], { env, timeout: 10_000 });
      const line = result.stdout.split(/\r?\n/).find((value) => value.startsWith('{"stdin":'));
      assert.ok(line, result.stdout + result.stderr);
      assert.deepEqual(JSON.parse(line), { stdin: true, stdout: true, args: ["terminalprobe"] });
    }
    const child = spawn(process.execPath, [...invocation.slice(1), "terminalprobe", "echo"], { env, stdio: ["pipe", "pipe", "pipe"] });
    const bytes = Buffer.from([0, 255, 128, 10]), chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk)); child.stdin.end(bytes);
    assert.equal(await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); }), 0);
    assert.deepEqual(Buffer.concat(chunks), bytes);
  } finally { await rm(root, { recursive: true, force: true }); }
});
