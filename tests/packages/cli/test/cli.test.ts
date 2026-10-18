import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { HostContextStore } from "../../../../core/packages/cli/src/host-context.js";
import { encodeHostRequest } from "../../../../core/packages/cli/src/host-transport.js";

const cli = fileURLToPath(new URL("../../../../core/packages/cli/src/cli.ts", import.meta.url));

test("base help describes ordinary Git development and local or SSH hosts", async () => {
  await withFixture(async (fixture) => {
    const result = await run(["--help"], fixture);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /dim create https:\/\/example.com\/team\/app.git dev/);
    for (const command of ["shell", "list", "create", "recreate", "discard"]) assert.match(result.stdout, new RegExp(`\\b${command}\\b`));
    assert.match(result.stdout, /--host <name>/);
    const create = await run(["create", "--help"], fixture);
    assert.equal(create.status, 0);
    assert.match(create.stdout, /<source> <name>/);
    assert.doesNotMatch(create.stdout, /--require-capability|--review-policy|--repo-ref/);
    assert.deepEqual(await readdir(fixture.root), ["bin"]);
  });
});

test("local list and hidden host list require no control plane, runtime or state provisioning", async () => {
  await withFixture(async (fixture) => {
    for (const args of [["ls", "--json"], ["workspace", "list", "--json"], ["__host", encodeHostRequest({ operation: "list" })]]) {
      const result = await run(args, fixture);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), []);
    }
    await assert.rejects(stat(path.join(fixture.root, "state")), { code: "ENOENT" });
    await assert.rejects(stat(path.join(fixture.root, "config")), { code: "ENOENT" });
  });
});

test("host commands select SSH context, support one-command overrides, and remove only client configuration", async () => {
  await withFixture(async (fixture) => {
    assert.equal((await run(["host", "add", "devbox", "--ssh", "alice@build-host"], fixture)).status, 0);
    assert.equal((await run(["host", "use", "devbox"], fixture)).status, 0);
    const hosts = await run(["host", "list", "--json"], fixture);
    assert.deepEqual(JSON.parse(hosts.stdout), [
      { name: "local", current: false }, { name: "devbox", ssh: "alice@build-host", current: true }
    ]);
    assert.equal((await run(["ls", "--json"], fixture)).status, 0);
    assert.equal((await request(fixture)).operation, "list");
    const override = await run(["--host", "local", "ls", "--json"], fixture);
    assert.deepEqual(JSON.parse(override.stdout), []);
    assert.equal((await new HostContextStore(path.join(fixture.root, "config")).resolve()).name, "devbox");
    assert.equal((await run(["host", "remove", "devbox"], fixture)).status, 0);
    assert.deepEqual(await new HostContextStore(path.join(fixture.root, "config")).resolve(), { name: "local" });
  });
});

test("remote create sends source and resources to the selected host without resolving client paths", async () => {
  await withFixture(async (fixture) => {
    await configureRemote(fixture);
    const result = await run(["--host", "devbox", "create", "/srv/repos/app", "dev", "--ref", "main",
      "--cpus", "4", "--memory", "8g", "--pids", "4096", "--git-user-name", "Alice", "--git-user-email", "alice@example.com", "--json"], fixture);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(await request(fixture), {
      operation: "create", input: {
        name: "dev", source: { url: "/srv/repos/app", ref: "main" },
        resources: { cpuCount: "4", memory: "8g", pidsLimit: "4096" }, git: { name: "Alice", email: "alice@example.com" }
      }
    });
    assert.equal(JSON.parse(result.stdout).name, "dev");
  });
});

test("workspace lifecycle and discard use the same host operation path", async () => {
  await withFixture(async (fixture) => {
    await configureRemote(fixture);
    for (const operation of ["show", "start", "stop", "restart", "recreate", "discard"]) {
      const args = ["--host", "devbox", "workspace", operation, "dev", "--json", ...(operation === "discard" ? ["--yes"] : [])];
      const result = await run(args, fixture);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(await request(fixture), { operation, input: { name: "dev" } });
    }
    const resources = await run(["--host", "devbox", "resources", "dev", "--cpus", "unlimited", "--json"], fixture);
    assert.equal(resources.status, 0, resources.stderr);
    assert.deepEqual(await request(fixture), { operation: "resources", input: { name: "dev", resources: { cpuCount: "unlimited" } } });
  });
});

test("image build runs on the selected host and reports the built image", async () => {
  await withFixture(async (fixture) => {
    await configureRemote(fixture);
    const result = await run(["--host", "devbox", "image", "build", "--image", "my-workspace:dev"], fixture);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(await request(fixture), { operation: "image.build", input: { image: "my-workspace:dev" } });
    assert.match(result.stdout, /Built workspace image 'my-workspace:dev' on 'devbox'/);
  });
});

test("doctor checks the selected host and returns failure status with either text or JSON output", async () => {
  await withFixture(async (fixture) => {
    await configureRemote(fixture);
    const healthy = await run(["--host", "devbox", "doctor"], fixture);
    assert.equal(healthy.status, 0, healthy.stderr);
    assert.match(healthy.stdout, /ok\tDocker\tready/);
    assert.deepEqual(await request(fixture), { operation: "doctor" });

    fixture.env.DIM_TEST_DOCTOR_FAIL = "1";
    const failed = await run(["--host", "devbox", "doctor"], fixture);
    assert.equal(failed.status, 2, failed.stderr);
    assert.match(failed.stdout, /fail\tDocker\tnot available/);
    const json = await run(["--host", "devbox", "doctor", "--json"], fixture);
    assert.equal(json.status, 2, json.stderr);
    assert.deepEqual(JSON.parse(json.stdout), [{ name: "Docker", ok: false, detail: "not available" }]);
  });
});

test("workspace inspection distinguishes recorded lifecycle from observed runtime status", async () => {
  await withFixture(async (fixture) => {
    await configureRemote(fixture);
    fixture.env.DIM_TEST_RUNTIME_STATUS = "stopped";
    const list = await run(["--host", "devbox", "ls"], fixture);
    assert.equal(list.status, 0, list.stderr);
    assert.match(list.stdout, /dev\trunning\/stopped\t/);
    const json = await run(["--host", "devbox", "show", "dev", "--json"], fixture);
    assert.equal(JSON.parse(json.stdout).runtimeStatus, "stopped");
    assert.equal(JSON.parse(json.stdout).phase, "running");
    fixture.env.DIM_TEST_RUNTIME_STATUS = "unavailable";
    const unavailable = await run(["--host", "devbox", "show", "dev"], fixture);
    assert.equal(unavailable.status, 0, unavailable.stderr);
    assert.match(unavailable.stdout, /running\/unavailable/);
    assert.match(unavailable.stdout, /Runtime: Docker unavailable/);
  });
});

test("shell, exec and run dispatch raw commands with the remote exit status", async () => {
  await withFixture(async (fixture) => {
    await configureRemote(fixture);
    const cases = [
      { args: ["shell", "dev"], command: ["bash", "-l"] },
      { args: ["run", "dev"], command: ["bash", "-l"] },
      { args: ["run", "dev", "shell"], command: ["bash", "-l"] },
      { args: ["exec", "dev", "--", "printf", "$HOME; no shell interpolation"], command: ["printf", "$HOME; no shell interpolation"] },
      { args: ["run", "dev", "exec", "--", "git", "status", "--short"], command: ["git", "status", "--short"] },
      { args: ["run", "dev", "custom", "--", "just", "test"], command: ["just", "test"] }
    ];
    for (const fixtureCase of cases) {
      const result = await run(["--host", "devbox", ...fixtureCase.args], fixture);
      assert.equal(result.status, 17, result.stderr);
      assert.equal(result.stdout, "command output\n");
      assert.deepEqual(await request(fixture), { operation: "exec", input: { name: "dev", command: fixtureCase.command, interactive: false } });
    }
  });
});

test("connect passes raw stdin and stdout through the selected SSH host", async () => {
  await withFixture(async (fixture) => {
    await configureRemote(fixture);
    const input = "protocol bytes\0\nnot JSON";
    const result = await run(["--host", "devbox", "connect", "dev", "3000"], fixture, input);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, input);
    assert.deepEqual(await request(fixture), { operation: "connect", input: { name: "dev", port: 3000 } });
  });
});

test("invalid and destructive arguments fail before contacting a remote host", async () => {
  await withFixture(async (fixture) => {
    await configureRemote(fixture);
    for (const args of [
      ["discard", "dev"], ["resources", "dev"], ["create", "url", "dev", "--git-user-name", "Alice"],
      ["run", "dev", "exec"], ["run", "dev", "shell", "extra"], ["exec", "dev"],
      ["connect", "dev", "0"], ["connect", "dev", "65536"], ["forward", "dev", "0:0"], ["forward", "dev", "0.0.0.0:3000:3000"],
      ["create", "url"], ["create", "url", "dev", "--repo-ref", "main"]
    ]) {
      const result = await run(["--host", "devbox", ...args], fixture);
      assert.notEqual(result.status, 0, args.join(" "));
      assert.notEqual(result.stderr, "");
    }
    await assert.rejects(stat(path.join(fixture.root, "request.json")), { code: "ENOENT" });
  });
});

test("malformed hidden host requests and unavailable workspaces report actionable errors", async () => {
  await withFixture(async (fixture) => {
    const malformed = await run(["__host", "invalid!"], fixture);
    assert.equal(malformed.status, 2);
    assert.match(malformed.stderr, /invalid host request/);
    const unknown = await run(["show", "missing", "--json"], fixture);
    assert.equal(unknown.status, 2);
    assert.match(unknown.stderr, /workspace 'missing' not found/);
    assert.equal(unknown.stderr.split("not found").length, 2);
  });
});

interface Fixture { root: string; env: NodeJS.ProcessEnv }

async function configureRemote(fixture: Fixture): Promise<void> {
  await new HostContextStore(path.join(fixture.root, "config")).add({ name: "devbox", ssh: "alice@build-host" });
}

async function request(fixture: Fixture): Promise<{ operation: string; input?: unknown }> {
  return JSON.parse(await readFile(path.join(fixture.root, "request.json"), "utf8"));
}

async function withFixture(action: (fixture: Fixture) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "dim-base-cli-"));
  const bin = path.join(root, "bin");
  await mkdir(bin);
  await writeFile(path.join(bin, "ssh"), `#!${process.execPath}
const {spawnSync} = require('node:child_process');
if (process.argv[3] !== '--' || process.argv[4] !== 'alice@build-host') throw Error('unexpected SSH argv');
const child = spawnSync('/bin/sh', ['-c', process.argv[5]], {stdio:'inherit'});
process.exitCode = child.status ?? 1;
`);
  await writeFile(path.join(bin, "dim"), `#!${process.execPath}
const fs = require('node:fs');
if (process.argv[2] !== '__host' || process.argv.length !== 4) throw Error('unexpected host command');
const request = JSON.parse(Buffer.from(process.argv[3], 'base64url').toString('utf8'));
fs.writeFileSync(process.env.DIM_TEST_REQUEST, JSON.stringify(request));
if (request.operation === 'exec') { process.stdout.write('command output\\n'); process.exitCode = 17; }
else if (request.operation === 'connect') { process.stdin.pipe(process.stdout); }
else if (request.operation === 'image.build') { process.stdout.write(JSON.stringify({image:request.input.image})); }
else if (request.operation === 'doctor') { const ok = !process.env.DIM_TEST_DOCTOR_FAIL; process.stdout.write(JSON.stringify([{name:'Docker',ok,detail:ok?'ready':'not available'}])); }
else {
  const record = { name: request.input?.name ?? 'dev', phase:'running', source:{url:'https://example.com/app',ref:'main'},resources:{cpuCount:'2',memory:'4g',pidsLimit:'2048'},image:'workspace' };
  if (process.env.DIM_TEST_RUNTIME_STATUS) record.runtimeStatus = process.env.DIM_TEST_RUNTIME_STATUS;
  if (record.runtimeStatus === 'unavailable') record.runtimeError = 'Docker unavailable';
  process.stdout.write(JSON.stringify(request.operation === 'list' ? [record] : request.operation === 'discard' ? {removed:true} : request.operation === 'resources' ? {workspace:record,recreated:true} : record));
}
`);
  await chmod(path.join(bin, "ssh"), 0o700);
  await chmod(path.join(bin, "dim"), 0o700);
  const fixture = { root, env: {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_RUNTIME_DIR: path.join(root, "runtime"),
    DIM_STATE_ROOT: path.join(root, "state"),
    DIM_TEST_REQUEST: path.join(root, "request.json"),
    DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE: undefined,
    DIM_NATIVE_ROOT_IMPORTER_CONNECTION_FILE: undefined
  } };
  try { await action(fixture); }
  finally { await rm(root, { recursive: true, force: true }); }
}

async function run(args: string[], fixture: Fixture, input?: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), cli, ...args], {
    env: fixture.env, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"]
  });
  if (input !== undefined) child.stdin?.end(input);
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  const status = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject); child.once("close", resolve);
  });
  return { status, stdout, stderr };
}
