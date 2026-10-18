#!/usr/bin/env node
/** Disposable SSH host verification. No installed DIM service or user SSH config is changed.
 * node base-workspace-ssh-smoke.mjs setup STATE_DIRECTORY
 * node base-workspace-ssh-smoke.mjs run STATE_DIRECTORY WORKSPACE_IMAGE
 * node base-workspace-ssh-smoke.mjs cleanup STATE_DIRECTORY
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { connect } from "node:net";
import { fileURLToPath } from "node:url";

const [mode, directory, image] = process.argv.slice(2);
if (!["setup", "run", "cleanup"].includes(mode) || !directory || !path.isAbsolute(directory)) {
  throw new Error("usage: node base-workspace-ssh-smoke.mjs setup|run|cleanup ABSOLUTE_STATE_DIRECTORY [WORKSPACE_IMAGE]");
}
const stateFile = path.join(directory, "state.json");
const repository = fileURLToPath(new URL("../..", import.meta.url));

async function run(file, args, options = {}) {
  const child = spawn(file, args, { env: options.env ?? process.env, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  const binary = [];
  if (options.binary) child.stdout.on("data", (chunk) => binary.push(chunk));
  else child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  child.stdin.on("error", (error) => { if (error.code !== "EPIPE") throw error; });
  child.stdin.end(options.input ?? "");
  const timer = setTimeout(() => child.kill("SIGKILL"), options.timeout ?? 120_000);
  try {
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (status) => resolve(status ?? 128));
    });
    if (options.allowFailure !== true && code !== 0) throw new Error(`${file} ${args[0]} failed (${code}): ${stderr || stdout}`);
    return { code, stdout: options.binary ? Buffer.concat(binary) : stdout, stderr };
  } finally { clearTimeout(timer); }
}
const docker = (args, options) => run("docker", args, options);
const save = (state) => writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
const read = async () => JSON.parse(await readFile(stateFile, "utf8"));

async function setup() {
  await mkdir(directory, { mode: 0o700 });
  const id = randomUUID();
  const state = { container: `dim-ssh-smoke-host-${id}`, name: `ssh-smoke-${id.slice(0, 8)}`,
    source: `/tmp/dim-ssh-source-${id}`, repository };
  await save(state);
  try {
    await run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", path.join(directory, "key")]);
    // This is a trusted host administrator, not a workspace: only this disposable
    // SSH test host receives the host Docker socket. Runtime containers receive none.
    await docker(["run", "--detach", "--name", state.container, "--publish", "127.0.0.1::22",
      "--mount", `type=bind,source=${repository},target=/opt/dim,readonly`,
      "--mount", "type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock",
      "alpine:3.23", "sleep", "infinity"]);
    await docker(["exec", state.container, "apk", "add", "--no-cache", "openssh-server", "nodejs", "git", "docker-cli", "coreutils", "util-linux"]);
    await docker(["exec", state.container, "sh", "-c", "mkdir -p /root/.ssh /var/lib/dim-test/run; chmod 700 /root/.ssh; passwd -d root; ssh-keygen -A"]);
    await docker(["cp", path.join(directory, "key.pub"), `${state.container}:/root/.ssh/authorized_keys`]);
    await docker(["exec", state.container, "chown", "root:root", "/root/.ssh/authorized_keys"]);
    await docker(["exec", state.container, "chmod", "600", "/root/.ssh/authorized_keys"]);
    const wrapper = '#!/bin/sh\nexport DIM_STATE_ROOT=/var/lib/dim-test/state\nexport XDG_RUNTIME_DIR=/var/lib/dim-test/run\nexec node /opt/dim/core/packages/cli/dist/cli.js "$@"\n';
    await writeFile(path.join(directory, "dim"), wrapper, { mode: 0o755 });
    await docker(["cp", path.join(directory, "dim"), `${state.container}:/usr/local/bin/dim`]);
    const config = "Port 22\nListenAddress 0.0.0.0\nHostKey /etc/ssh/ssh_host_ed25519_key\nPermitRootLogin prohibit-password\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nPubkeyAuthentication yes\nAuthorizedKeysFile /root/.ssh/authorized_keys\nPrintMotd no\nLogLevel VERBOSE\n";
    await writeFile(path.join(directory, "sshd_config"), config);
    await docker(["cp", path.join(directory, "sshd_config"), `${state.container}:/etc/ssh/sshd_config`]);
    await docker(["exec", state.container, "chown", "root:root", "/etc/ssh/sshd_config", "/usr/local/bin/dim"]);
    await docker(["exec", "--detach", state.container, "/usr/sbin/sshd", "-D", "-E", "/tmp/sshd.log"]);
    const port = (await docker(["port", state.container, "22/tcp"])).stdout.trim().split(":").at(-1);
    const hostKey = (await docker(["exec", state.container, "cat", "/etc/ssh/ssh_host_ed25519_key.pub"])).stdout.trim();
    await writeFile(path.join(directory, "known_hosts"), `[127.0.0.1]:${port} ${hostKey}\n`);
    await writeFile(path.join(directory, "ssh_config"), `Host dim-smoke-host\n  HostName 127.0.0.1\n  Port ${port}\n  User root\n  IdentityFile ${directory}/key\n  IdentitiesOnly yes\n  StrictHostKeyChecking yes\n  UserKnownHostsFile ${directory}/known_hosts\n  LogLevel ERROR\n  BatchMode yes\n  ConnectTimeout 2\n`);
    const bin = path.join(directory, "bin");
    await mkdir(bin);
    const quoted = path.join(directory, "ssh_config").replaceAll("'", "'\\''");
    await writeFile(path.join(bin, "ssh"), `#!/bin/sh\nexec /usr/bin/ssh -F '${quoted}' "$@"\n`, { mode: 0o755 });
    let ready = false;
    let sshError = "";
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const result = await run("/usr/bin/ssh", ["-F", path.join(directory, "ssh_config"), "dim-smoke-host", "true"], { allowFailure: true, timeout: 2_000 });
      if (result.code === 0) { ready = true; break; }
      sshError = result.stderr;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!ready) {
      const logs = await docker(["exec", state.container, "cat", "/tmp/sshd.log"], { allowFailure: true });
      const verbose = await run("/usr/bin/ssh", ["-vvv", "-F", path.join(directory, "ssh_config"), "dim-smoke-host", "true"], { allowFailure: true, timeout: 5_000 });
      throw new Error(`SSH host did not become ready: ${sshError}\n${verbose.stderr}\n${logs.stdout}`);
    }
    await docker(["exec", state.container, "mkdir", state.source]);
    await docker(["exec", state.container, "git", "-C", state.source, "init", "--initial-branch=main"]);
    await docker(["exec", state.container, "sh", "-c", 'printf "remote-only checkout\\n" > "$1/remote.txt"', "smoke", state.source]);
    await docker(["exec", state.container, "git", "-C", state.source, "add", "."]);
    await docker(["exec", state.container, "git", "-C", state.source, "-c", "user.name=SSH smoke", "-c", "user.email=ssh@example.invalid", "commit", "-m", "remote source"]);
    console.log(`SSH host ready on 127.0.0.1:${port}; state: ${directory}`);
  } catch (error) { await cleanup(state); throw error; }
}

async function verify(state) {
  if (!image) throw new Error("run requires a built workspace image");
  const client = path.join(directory, "client");
  const env = { ...process.env, HOME: client, XDG_CONFIG_HOME: path.join(client, "config"),
    XDG_DATA_HOME: path.join(client, "data"), DIM_STATE_ROOT: path.join(client, "state"),
    PATH: `${directory}/bin:${process.env.PATH}` };
  const cli = (args, options = {}) => run(process.execPath, [path.join(repository, "core/packages/cli/dist/cli.js"), ...args], { env, ...options });
  try {
    await assert.rejects(access(state.source));
    await cli(["host", "add", "smoke", "--ssh", "dim-smoke-host"]);
    await cli(["host", "use", "smoke"]);
    assert.deepEqual(JSON.parse((await cli(["ls", "--json"])).stdout), []);
    const created = await cli(["create", state.source, state.name, "--image", image,
      "--cpus", "1", "--memory", "2g", "--pids", "512", "--json"]);
    const record = JSON.parse(created.stdout);
    state.workspaceId = record.id;
    await save(state);
    assert.equal(record.source.url, state.source);
    assert.equal(record.phase, "running");
    assert.equal((await cli(["exec", state.name, "--", "cat", "remote.txt"])).stdout.trim(), "remote-only checkout");
    const streamed = await cli(["exec", state.name, "--", "sh", "-c", 'IFS= read -r value; printf "remote:%s\\n" "$value"; exit 37'],
      { input: "stdin-preserved\n", allowFailure: true });
    assert.equal(streamed.code, 37, streamed.stderr);
    assert.equal(streamed.stdout.trim(), "remote:stdin-preserved");
    console.log("real SSH host selection, remote-only source and exec stdin/exit: passed");
    await cli(["exec", state.name, "--", "sh", "-c", 'printf preserved > local.txt; printf home-preserved > /home/dim/remote-smoke.txt']);
    await cli(["stop", state.name, "--json"]);
    await cli(["start", state.name, "--json"]);
    await cli(["recreate", state.name, "--json"]);
    assert.equal((await cli(["exec", state.name, "--", "cat", "local.txt"])).stdout, "preserved");
    assert.equal((await cli(["exec", state.name, "--", "cat", "/home/dim/remote-smoke.txt"])).stdout, "home-preserved");
    const prefix = `dim-workspace-${createHash("sha256").update(record.id).digest("hex").slice(0, 24)}`;
    await verifyConnections(state, env, cli, prefix);
    const runtime = JSON.parse((await docker(["container", "inspect", prefix])).stdout)[0];
    assert.equal(runtime.HostConfig.Runtime, "sysbox-runc");
    assert.equal(runtime.HostConfig.Privileged, false);
    assert.equal(runtime.Mounts.length, 3);
    assert.ok(runtime.Mounts.every((mount) => mount.Type === "volume"));
    await assert.rejects(access(path.join(client, "state")));
    console.log("remote lifecycle, persistent data and absence of host mounts in workspace: passed");
    await cli(["discard", state.name, "--yes", "--json"]);
    assert.deepEqual(JSON.parse((await cli(["ls", "--json"])).stdout), []);
    console.log("remote discard: passed");
  } finally { await cleanup(state); }
}

async function verifyConnections(state, env, cli, prefix) {
  const payload = Buffer.from(Array.from({ length: 65_536 }, (_, i) => i % 256));
  const server = `require("node:net").createServer({allowHalfOpen:true}, socket => {
    const chunks=[]; socket.on("data",chunk=>chunks.push(chunk));
    socket.on("end",()=>socket.end(Buffer.concat(chunks)));
    socket.on("error",()=>socket.destroy());
  }).listen(3000,"127.0.0.1")`;
  await docker(["exec", "--detach", "--user", "dim", prefix, "node", "-e", server]);
  let direct;
  for (let attempt = 0; attempt < 20; attempt++) {
    direct = await cli(["connect", state.name, "3000"], { input: payload, binary: true, allowFailure: true, timeout: 10_000 });
    if (direct.code === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(direct.code, 0, direct.stderr);
  assert.deepEqual(direct.stdout, payload, "SSH stdio connection altered binary data or lost half-close output");
  const child = spawn(process.execPath, [path.join(repository, "core/packages/cli/dist/cli.js"),
    "forward", state.name, "0:3000"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let diagnostic = "";
  const closed = new Promise((resolve, reject) => {
    child.once("error", reject); child.once("close", (code) => resolve(code));
  });
  const deadline = setTimeout(() => child.kill("SIGKILL"), 30_000);
  let idle;
  try {
    const port = await new Promise((resolve, reject) => {
      child.stderr.setEncoding("utf8").on("data", (chunk) => {
        diagnostic += chunk;
        const match = /Forwarding 127\.0\.0\.1:(\d+)/.exec(diagnostic);
        if (match) resolve(Number(match[1]));
      });
      child.once("close", () => reject(new Error(`forward exited before listening: ${diagnostic}`)));
      child.once("error", reject);
    });
    const exchange = () => new Promise((resolve, reject) => {
      const socket = connect({ host: "127.0.0.1", port });
      const chunks=[];
      socket.setTimeout(10_000, () => socket.destroy(new Error("forward response timed out")));
      socket.once("error", reject);
      socket.once("connect", () => socket.end(payload));
      socket.on("data", (chunk) => chunks.push(chunk));
      socket.once("end", () => resolve(Buffer.concat(chunks)));
    });
    const replies = await Promise.all([exchange(), exchange()]);
    replies.forEach((reply) => assert.deepEqual(reply, payload));
    // Hold an upstream connection open while cancelling the listener. Its host
    // transport and in-workspace bridge must both terminate without a client EOF.
    idle = connect({ host: "127.0.0.1", port });
    idle.on("error", () => {});
    await new Promise((resolve) => idle.once("connect", resolve));
    await new Promise((resolve) => setTimeout(resolve, 500));
    child.kill("SIGTERM");
    assert.equal(await closed, 143, diagnostic);
  } finally {
    clearTimeout(deadline);
    idle?.destroy();
    if (child.exitCode === null) { child.kill("SIGKILL"); await closed; }
  }
  const countBridge = `const fs=require("node:fs");let n=0;
    for(const id of fs.readdirSync("/proc")){if(!/^\\d+$/.test(id)||Number(id)===process.pid)continue;
      try{const a=fs.readFileSync("/proc/"+id+"/cmdline","utf8").split("\\0");
      if(a[1]==="-e"&&a[2]?.includes("workspace connection failed"))n++;}catch{}}
    console.log(n)`;
  let remaining = -1;
  for (let attempt = 0; attempt < 20; attempt++) {
    remaining = Number((await docker(["exec", "--user", "dim", prefix, "node", "-e", countBridge])).stdout.trim());
    if (remaining === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(remaining, 0, "cancelled forward left a bridge process inside the workspace");
  console.log("SSH binary connect, concurrent loopback forwards, half-close and cancellation cleanup: passed");
}

async function cleanup(state) {
  if (!state.workspaceId) {
    const saved = await docker(["exec", state.container, "cat", `/var/lib/dim-test/state/workspaces/${state.name}.json`], { allowFailure: true });
    if (saved.code === 0) {
      try { state.workspaceId = JSON.parse(saved.stdout).id; } catch { /* no published record */ }
    }
  }
  if (typeof state.workspaceId === "string" && /^[0-9a-f-]{36}$/.test(state.workspaceId)) {
    const prefix = `dim-workspace-${createHash("sha256").update(state.workspaceId).digest("hex").slice(0, 24)}`;
    await docker(["rm", "--force", prefix], { allowFailure: true });
    await docker(["network", "rm", prefix], { allowFailure: true });
    for (const role of ["home", "checkout", "docker"]) await docker(["volume", "rm", `${prefix}-${role}`], { allowFailure: true });
    assert.notEqual((await docker(["container", "inspect", prefix], { allowFailure: true })).code, 0, "workspace container survived cleanup");
    assert.notEqual((await docker(["network", "inspect", prefix], { allowFailure: true })).code, 0, "workspace network survived cleanup");
    for (const role of ["home", "checkout", "docker"]) {
      assert.notEqual((await docker(["volume", "inspect", `${prefix}-${role}`], { allowFailure: true })).code, 0, `${role} volume survived cleanup`);
    }
  }
  await docker(["rm", "--force", state.container], { allowFailure: true });
  assert.notEqual((await docker(["container", "inspect", state.container], { allowFailure: true })).code, 0, "SSH host survived cleanup");
  await rm(directory, { recursive: true, force: true });
}

if (mode === "setup") await setup();
else if (mode === "run") await verify(await read());
else await cleanup(await read());
