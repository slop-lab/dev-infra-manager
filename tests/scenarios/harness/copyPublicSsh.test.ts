import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { workspaceRecord } from "../../support/workspaceFixture.js";

const cli = fileURLToPath(new URL("../../../packages/cli/core/src/cli.ts", import.meta.url));
const hostMain = fileURLToPath(new URL("../../../packages/host/core/src/application/host-main.ts", import.meta.url));
const runnerModule = new URL("../../../packages/host/core/src/runner.ts", import.meta.url).href;
const shell = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

test("public dim cp transfers through an authenticated disposable OpenSSH server without operator credentials", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "dim-real-ssh-copy-")), bin = join(root, "bin"), guest = join(root, "guest");
  let daemon: ReturnType<typeof spawn> | undefined;
  const env = { ...process.env, XDG_CONFIG_HOME: join(root, "config"), PATH: `${bin}:${process.env.PATH ?? ""}` };
  try {
    await mkdir(bin); await mkdir(guest);
    await run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", join(root, "client")]);
    await run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", join(root, "host")]);
    const server = createServer(); server.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture port missing");
    await new Promise<void>((done) => server.close(() => done()));
    const state = join(root, "state"), plugins = join(root, "plugins");
    await mkdir(join(state, "workspaces"), { recursive: true }); await mkdir(plugins);
    await writeFile(join(state, "workspaces/dev.json"), JSON.stringify(workspaceRecord("dev", { runtime: "copy-fixture" })), { mode: 0o600 });
    const provider = join(plugins, "fixture.mjs");
    await writeFile(provider, `import{ProcessRunner}from${JSON.stringify(runnerModule)};export const hostPlugin={name:'copy-fixture',runtime:{name:'copy-fixture',isolation:'process',create(){const runner=new ProcessRunner();return{inspect:async()=>({running:true}),copy:async(_record,operation,options)=>runner.runStreaming(operation.command[0],operation.command.slice(1),{...options,cwd:${JSON.stringify(guest)}})}}}};`);
    await writeFile(join(plugins, "plugins.json"), JSON.stringify({ schemaVersion: 1, plugins: [provider] }), { mode: 0o600 });
    const launcher = `#!/bin/sh\nexec ${shell(process.execPath)} --conditions=dim-source --import ${shell(import.meta.resolve("tsx"))} ${shell(hostMain)} "$@"\n`;
    await writeFile(join(bin, "dim"), launcher, { mode: 0o700 });
    await writeFile(join(root, "force"), `#!/bin/sh\nexport DIM_STATE_ROOT=${shell(state)}\nexport DIM_PLUGIN_HOME=${shell(plugins)}\nexport PATH=${shell(`${bin}:/usr/bin:/bin`)}\nexec /bin/sh -c "$SSH_ORIGINAL_COMMAND"\n`, { mode: 0o700 });
    const config = join(root, "sshd_config");
    await writeFile(config, `ListenAddress 127.0.0.1\nPort ${address.port}\nHostKey ${root}/host\nPidFile ${root}/sshd.pid\nAuthorizedKeysFile ${root}/client.pub\nStrictModes yes\nUsePAM no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nAuthenticationMethods publickey\nAllowUsers ${userInfo().username}\nForceCommand ${root}/force\n`, { mode: 0o600 });
    daemon = spawn("/usr/sbin/sshd", ["-D", "-e", "-f", config], { stdio: ["ignore", "ignore", "pipe"] });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("disposable SSH listener deadline exceeded")), 5000);
      daemon?.stderr?.on("data", (chunk: Buffer) => { if (chunk.toString().includes("Server listening on")) { clearTimeout(timeout); resolve(); } });
      daemon?.once("error", (error) => { clearTimeout(timeout); reject(error); });
      daemon?.once("close", (code) => { clearTimeout(timeout); reject(new Error(`disposable SSH listener exited ${code}`)); });
    });
    await writeFile(join(root, "known_hosts"), `[127.0.0.1]:${address.port} ${await readFile(join(root, "host.pub"), "utf8")}`, { mode: 0o600 });
    await writeFile(join(root, "ssh_config"), `Host copy-fixture\n HostName 127.0.0.1\n Port ${address.port}\n User ${userInfo().username}\n IdentityFile ${root}/client\n IdentitiesOnly yes\n UserKnownHostsFile ${root}/known_hosts\n StrictHostKeyChecking yes\n LogLevel ERROR\n`, { mode: 0o600 });
    await writeFile(join(bin, "ssh"), `#!/bin/sh\nexec /usr/bin/ssh -F ${shell(join(root, "ssh_config"))} "$@"\n`, { mode: 0o700 });
    const dim = (args: readonly string[]) => run(process.execPath, ["--conditions=dim-source", "--import", import.meta.resolve("tsx"), cli, ...args], env);
    assert.equal((await dim(["host", "add", "copy-ssh", "--ssh", "copy-fixture"])).code, 0);
    const local = join(root, "operator.bin"), received = join(root, "received.bin"), payload = Buffer.from([0, 255, 17, 10, 13, 128]);
    await writeFile(local, payload);
    const uploaded = await dim(["--host", "copy-ssh", "cp", local, "dev:remote.bin"]);
    assert.equal(uploaded.code, 0, uploaded.stderr);
    assert.deepEqual(await readFile(join(guest, "remote.bin")), payload);
    const downloaded = await dim(["--host", "copy-ssh", "cp", "dev:remote.bin", received]);
    assert.equal(downloaded.code, 0, downloaded.stderr); assert.deepEqual(await readFile(received), payload);
    const refused = await dim(["--host", "copy-ssh", "cp", "dev:remote.bin", received]);
    assert.equal(refused.code, 2, refused.stderr); assert.deepEqual(await readFile(received), payload);
    await writeFile(local, "replacement");
    const replacement = await dim(["--host", "copy-ssh", "cp", "--overwrite", local, "dev:remote.bin"]);
    assert.equal(replacement.code, 0, replacement.stderr);
    assert.equal(await readFile(join(guest, "remote.bin"), "utf8"), "replacement");
  } finally {
    if (daemon && daemon.exitCode === null) { const closed = once(daemon, "close"); daemon.kill("SIGTERM"); await closed; }
    await rm(root, { recursive: true, force: true });
  }
});

async function run(file: string, args: readonly string[], env = process.env): Promise<{ readonly code: number | null; readonly stdout: Buffer; readonly stderr: string }> {
  const child = spawn(file, [...args], { env, stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 });
  const stdout: Buffer[] = []; let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk)); child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  return { code, stdout: Buffer.concat(stdout), stderr };
}
