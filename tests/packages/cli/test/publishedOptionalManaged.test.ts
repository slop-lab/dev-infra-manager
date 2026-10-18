import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const run = promisify(execFile);
const cliPackage = fileURLToPath(new URL("../../../../core/packages/cli/", import.meta.url));
const corePackage = fileURLToPath(new URL("../../../../core/packages/core/", import.meta.url));

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

    for (const arguments_ of [["managed", "--help"], ["controller", "restart"]]) {
      await assert.rejects(run(process.execPath, [executable, ...arguments_], options), (error: unknown) => {
        assert.ok(error instanceof Error && "code" in error && "stderr" in error);
        assert.equal(error.code, 2);
        assert.match(String(error.stderr), /dim installer install core --with-managed/);
        assert.doesNotMatch(String(error.stderr), /ERR_MODULE_NOT_FOUND|node_modules/);
        return true;
      });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
