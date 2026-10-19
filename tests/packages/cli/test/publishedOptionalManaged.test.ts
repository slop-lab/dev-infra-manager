import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const run = promisify(execFile);
const cliPackage = fileURLToPath(new URL("../../../../packages/cli", import.meta.url));
const corePackage = fileURLToPath(new URL("../../../../packages/host/core", import.meta.url));

test("published base CLI works without managed services and gives an installation hint only when selected", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "dim-published-base-"));
  const scope = path.join(directory, "node_modules", "@slop-lab");
  await mkdir(scope, { recursive: true });
  try {
    await Promise.all([
      cp(path.join(cliPackage, "dist"), path.join(scope, "dim-cli"), { recursive: true }),
      cp(path.join(corePackage, "dist"), path.join(scope, "dim-core"), { recursive: true }),
      cp(path.join(cliPackage, "node_modules", "commander"), path.join(directory, "node_modules", "commander"), {
        recursive: true, dereference: true
      })
    ]);
    const metadata = JSON.parse(await readFile(path.join(scope, "dim-cli", "package.json"), "utf8"));
    assert.equal(metadata.dependencies["@slop-lab/dim-managed"], undefined);
    assert.equal(metadata.peerDependencies["@slop-lab/dim-managed"], metadata.version);
    assert.deepEqual(metadata.peerDependenciesMeta["@slop-lab/dim-managed"], { optional: true });

    const executable = path.join(scope, "dim-cli", "cli.js");
    const options = { cwd: directory, env: {
      ...process.env,
      XDG_CONFIG_HOME: path.join(directory, "config"),
      DIM_STATE_ROOT: path.join(directory, "state")
    } };
    const help = await run(process.execPath, [executable, "--help"], options);
    assert.match(help.stdout, /Persistent, isolated local and remote development/);
    const list = await run(process.execPath, [executable, "ls", "--json"], options);
    assert.deepEqual(JSON.parse(list.stdout), []);
    const doctorHelp = await run(process.execPath, [executable, "doctor", "--help"], options);
    assert.match(doctorHelp.stdout, /Check development host readiness/);

    for (const arguments_ of [["managed", "--help"], ["controller", "restart"], ["create", "dim://project", "dev", "--json"]]) {
      await assert.rejects(run(process.execPath, [executable, ...arguments_], options), (error: unknown) => {
        assert.ok(error instanceof Error && "code" in error && "stderr" in error);
        assert.equal(error.code, 2);
        assert.match(String(error.stderr), /dim installer install core --with-managed/);
        assert.doesNotMatch(String(error.stderr), /ERR_MODULE_NOT_FOUND|node_modules/);
        return true;
      });
    }
    // The client remains base-only; optional administration is installed only
    // in the remote host graph and receives argument bytes through stdio RPC.
    const remote = path.join(directory, "remote");
    await cp(path.join(directory, "node_modules"), path.join(remote, "node_modules"), { recursive: true });
    const managed = path.join(remote, "node_modules", "@slop-lab", "dim-managed");
    await mkdir(managed, { recursive: true });
    await writeFile(path.join(managed, "package.json"), JSON.stringify({
      name: "@slop-lab/dim-managed", type: "module", exports: { "./cli": "./cli.js" }
    }));
    await writeFile(path.join(managed, "cli.js"), `export async function runManagedCli(args) {
      console.log(JSON.stringify({ args, host: process.env.DIM_TEST_REMOTE_HOST }));
    }`);
    const bin = path.join(directory, "bin");
    await mkdir(bin);
    await writeFile(path.join(bin, "ssh"), `#!${process.execPath}
const { spawnSync } = require("node:child_process");
const command = process.argv.at(-1);
const encoded = /__host ([A-Za-z0-9_-]+)/.exec(command)?.[1];
if (!encoded) process.exit(97);
const result = spawnSync(process.execPath, [process.env.DIM_TEST_REMOTE_CLI, "__host", encoded], {
  stdio: "inherit", env: { ...process.env, DIM_TEST_REMOTE_HOST: "devbox" }
});
process.exit(result.status ?? 1);
`, { mode: 0o700 });
    const remoteOptions = { ...options, env: { ...options.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      DIM_TEST_REMOTE_CLI: path.join(remote, "node_modules", "@slop-lab", "dim-cli", "cli.js")
    } };
    await run(process.execPath, [executable, "host", "add", "devbox", "--ssh", "developer@devbox"], remoteOptions);
    const arguments_ = ["project", "show", "a;$(printf injected)'\"", "--json"];
    for (const selection of [["--host", "devbox"], ["--host=devbox"]]) {
      const result = await run(process.execPath, [executable, ...selection, "managed", ...arguments_], remoteOptions);
      assert.deepEqual(JSON.parse(result.stdout), { args: arguments_, host: "devbox" });
    }
    await run(process.execPath, [executable, "host", "use", "devbox"], remoteOptions);
    const selected = await run(process.execPath, [executable, "managed", ...arguments_], remoteOptions);
    assert.deepEqual(JSON.parse(selected.stdout), { args: arguments_, host: "devbox" });
    const alias = await run(process.execPath, [executable, ...arguments_], remoteOptions);
    assert.deepEqual(JSON.parse(alias.stdout), { args: arguments_, host: "devbox" });
    await assert.rejects(run(process.execPath, [executable, "--host", "local", "managed", "--help"], remoteOptions),
      (error: unknown) => error instanceof Error && "stderr" in error && /not installed on this host/.test(String(error.stderr)));
    await assert.rejects(run(process.execPath, [executable, "controller", "restart"], remoteOptions),
      (error: unknown) => error instanceof Error && "stderr" in error && /not installed on this host/.test(String(error.stderr)));

  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
