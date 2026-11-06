import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { installDimCli } from "../../packages/installer/src/cliInstall.js";
import { hostExecutable } from "../support/host-executable.js";
import { realSshFixture } from "../support/real-ssh.js";
import { runCommand } from "../scenarios/web-lifecycle/process.js";

const repository = path.resolve(import.meta.dirname, "../..");
test("normal installed public CLI crosses real pinned SSH once, preserving arguments, binary stdin and status", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dim-installed-real-ssh-")); let close: (() => Promise<void>) | undefined;
  try {
    const home = path.join(root, "home"), data = path.join(root, "data"), bin = path.join(home, ".local/bin"), plugins = path.join(root, "plugins");
    await mkdir(bin, { recursive: true });
    const host = path.join(data, "runtime/current/node_modules/.bin/dim-host"); await mkdir(path.dirname(host), { recursive: true });
    await symlink(await hostExecutable(root, true), host);
    const cli = path.join(repository, "packages/cli/core/dist"), contracts = path.join(repository, "packages/contracts/cli-host/dist");
    const commander = await realpath(path.join(repository, "packages/cli/core/node_modules/commander")), stage = path.join(root, "stage-cli.mjs");
    await writeFile(stage, `#!${process.execPath}\n// @ts-check\nimport fs from 'node:fs/promises';import p from 'node:path';const prefix=process.argv[process.argv.indexOf('--prefix')+1];const scope=p.join(prefix,'node_modules/@slop-lab');await fs.mkdir(scope,{recursive:true});await fs.cp(${JSON.stringify(cli)},p.join(scope,'dim-cli'),{recursive:true});await fs.cp(${JSON.stringify(contracts)},p.join(scope,'dim-contracts-cli-host'),{recursive:true});await fs.symlink(${JSON.stringify(commander)},p.join(prefix,'node_modules/commander'),'dir');await fs.mkdir(p.join(prefix,'node_modules/.bin'),{recursive:true});await fs.symlink('../@slop-lab/dim-cli/cli.js',p.join(prefix,'node_modules/.bin/dim'));await fs.chmod(p.join(scope,'dim-cli/cli.js'),0o755);\n`, { mode: 0o700 });
    const installed = await installDimCli({ version: "0.10.0", exposeOnPath: true, binDirectory: bin, dataHome: data,
      configPath: path.join(root, "installer.json"), packageSpecifiers: ["fixture-built-cli"], npmCommand: stage });
    assert.equal(installed.mode, "direct");
    const plugin = path.join(plugins, "node_modules/fixture"); await mkdir(plugin, { recursive: true });
    const ts = await import("typescript"), source = await readFile(path.join(repository, "tests/cli/fixtures/transport-probe.ts"), "utf8");
    await writeFile(path.join(plugin, "index.js"), `// @ts-check\n${ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2024 } }).outputText}`);
    await writeFile(path.join(plugin, "package.json"), '{"type":"module","main":"index.js"}');
    await writeFile(path.join(plugins, "plugins.json"), '{"schemaVersion":1,"plugins":["fixture"]}');
    const remoteEnvironment = { HOME: home, PATH: `${bin}:${path.dirname(process.execPath)}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      XDG_CONFIG_HOME: path.join(root, "remote-config"), DIM_DATA_HOME: data, DIM_STATE_ROOT: path.join(root, "state"), DIM_PLUGIN_HOME: plugins };
    const ssh = await realSshFixture(root, remoteEnvironment); close = ssh.close;
    const env = { ...process.env, PATH: `${ssh.bin}:${process.env.PATH ?? ""}`, XDG_CONFIG_HOME: path.join(root, "client-config"),
      DIM_DATA_HOME: data, DIM_STATE_ROOT: path.join(root, "state"), DIM_PLUGIN_HOME: plugins };
    await runCommand(installed.executable, ["host", "add", "selected", "--ssh", ssh.target], { env });
    for (const args of [["--version"], ["doctor", "--json"], ["plugins"], ["list", "--json"]]) {
      const result = await runCommand(installed.executable, ["--host", "selected", ...args], { env, acceptFailure: true });
      const local = await runCommand(installed.executable, ["--host", "local", ...args], { env, acceptFailure: true });
      assert.equal(result.exitCode, local.exitCode, `${result.stderr}\n${ssh.diagnostics()}`); assert.equal(result.stdout, local.stdout);
      if (args[0] === "--version") assert.equal(result.stdout.trim(), "0.10.0"); else JSON.parse(result.stdout);
    }
    const args = ["", "literal;$(touch forbidden)", "--host", "not-selected"];
    const result = await runCommand(installed.executable, ["--host", "selected", "transport-probe", "--", ...args], { env });
    assert.deepEqual(JSON.parse(result.stdout), ["--", ...args]);
    const child = spawn(installed.executable, ["--host", "selected", "transport-probe", "bytes"], { env, stdio: ["pipe", "pipe", "pipe"] });
    const bytes = Buffer.from([0, 255, 10, 128, 65]), chunks: Buffer[] = []; let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk)); child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); }); child.stdin.end(bytes);
    const status = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    assert.equal(status, 37, stderr); assert.deepEqual(Buffer.concat(chunks), bytes);
  } finally { await close?.(); await rm(root, { recursive: true, force: true }); }
});
