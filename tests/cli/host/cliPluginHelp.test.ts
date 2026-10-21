import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Writable } from "node:stream";
import { afterEach, expect, it } from "vitest";
import { callHost } from "../../../packages/cli/core/src/host-transport.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const cli = fileURLToPath(new URL("../../../packages/cli/core/src/cli.ts", import.meta.url));
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "dim-cli-plugin-help-")); roots.push(root);
  const plugins = join(root, "plugins"), config = join(root, "config"), bin = join(root, "bin");
  await mkdir(join(plugins, "node_modules/@slop-lab"), { recursive: true }); await mkdir(bin);
  await mkdir(join(config, "dim"), { recursive: true });
  const env = { ...process.env, DIM_PLUGIN_HOME: plugins, XDG_CONFIG_HOME: config, DIM_DATA_HOME: join(root, "data"), PATH: `${bin}:${process.env.PATH ?? ""}` };
  const run = (args: string[]) => promisify(execFile)(process.execPath, ["--disable-warning=DEP0205", "--conditions=dim-source", "--import", "tsx", cli, ...args], { env, timeout: 10_000 });
  return { root, plugins, config, bin, run, async installLlmPlugin() {
    await symlink(fileURLToPath(new URL("../../../packages/cli/plugins/llm-router", import.meta.url)), join(plugins, "node_modules/@slop-lab/dim-cli-plugin-llm-router"), "dir");
    await writeFile(join(plugins, "plugins.json"), JSON.stringify({ schemaVersion: 1, plugins: ["@slop-lab/dim-cli-plugin-llm-router"] }));
  } };
}
it("discovers an actual installed CLI plugin in root help without intercepting its own command help", async () => {
  const f = await fixture(); await f.installLlmPlugin();
  const help = await f.run(["--help"]);
  expect(help.stderr).toBe("");
  expect(help.stdout).toContain("Optional commands on host 'local':");
  expect(help.stdout).toMatch(/llm-router\s+Inspect and manage an LLM router/);
  const feature = await f.run(["llm-router", "--help"]);
  expect(feature.stdout).toContain("dim llm-router OPERATION --connection");
  expect(feature.stdout).toContain("request.cancel");
});
it("keeps base help clean when no optional commands are installed or a selected host fails", async () => {
  const f = await fixture();
  const empty = await f.run(["--help"]); expect(empty.stdout).toContain("Persistent, isolated"); expect(empty.stdout).not.toContain("Optional commands on host");
  await writeFile(join(f.config, "dim/hosts.json"), JSON.stringify({ current: "remote", hosts: [{ name: "local" }, { name: "remote", ssh: "fixture-target" }] }));
  await writeFile(join(f.bin, "ssh"), `#!${process.execPath}\n// @ts-check\nconsole.error('fixture host unavailable');process.exit(255);\n`, { mode: 0o700 });
  const failed = await f.run(["--host", "remote", "--help"]);
  expect(failed.stdout).toContain("Persistent, isolated"); expect(failed.stdout).not.toContain("Optional commands on host"); expect(failed.stderr).toBe("");
});
it("uses selected host metadata and refuses terminal controls and oversized descriptions", async () => {
  const f = await fixture(); await f.installLlmPlugin();
  await writeFile(join(f.config, "dim/hosts.json"), JSON.stringify({ current: "local", hosts: [{ name: "local" }, { name: "remote", ssh: "fixture-target" }] }));
  const writeSsh = async (description: string) => writeFile(join(f.bin, "ssh"), `#!${process.execPath}\n// @ts-check\nconsole.log(${JSON.stringify(JSON.stringify([{ name: "remote-tools", commands: [{ name: "remote-task", description }] }]))});\n`, { mode: 0o700 });
  await writeSsh("Run a remote task");
  const selected = await f.run(["--host=remote", "-h"]); expect(selected.stdout).toContain("Optional commands on host 'remote':"); expect(selected.stdout).toContain("remote-task"); expect(selected.stdout).not.toContain("llm-router");
  for (const description of ["bad\u001b[31m", "x".repeat(257)]) {
    await writeSsh(description); const invalid = await f.run(["--host=remote", "--help"]);
    expect(invalid.stdout).not.toContain("remote-task"); expect(invalid.stderr).toBe("");
  }
});
it("bounds combined host metadata output before buffering stdout or stderr", async () => {
  const quiet = new Writable({ write(_chunk, _encoding, done) { done(); } });
  for (const stream of ["stdout", "stderr"]) await expect(callHost({ name: "local" }, { operation: "plugins" }, {
    localCommand: { file: process.execPath, args: ["-e", `process.${stream}.write('x'.repeat(4096));setTimeout(()=>{},30000)`] }, maxOutputBytes: 1024, stderr: quiet
  })).rejects.toThrow("size limit");
});
it("caps slow selected-host discovery so base help remains available", async () => {
  const f = await fixture();
  await writeFile(join(f.config, "dim/hosts.json"), JSON.stringify({ current: "remote", hosts: [{ name: "local" }, { name: "remote", ssh: "fixture-target" }] }));
  await writeFile(join(f.bin, "ssh"), `#!${process.execPath}\n// @ts-check\nsetTimeout(()=>console.log('[]'),30000);\n`, { mode: 0o700 });
  const started = Date.now(), help = await f.run(["--help"]);
  expect(Date.now() - started).toBeLessThan(5_000); expect(help.stdout).toContain("Persistent, isolated"); expect(help.stderr).toBe("");
});
