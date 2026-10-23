import { createHostRequest } from "@slop-lab/dim-contracts-cli-host";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { Writable } from "node:stream";
import { afterEach, expect, it } from "vitest";
import { callHost } from "../../../packages/cli/core/src/host-transport.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const cli = fileURLToPath(new URL("../../../packages/cli/core/src/cli.ts", import.meta.url));
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "dim-host-plugin-help-")); roots.push(root);
  const plugins = join(root, "plugins"), config = join(root, "config"), bin = join(root, "bin");
  await mkdir(join(plugins, "node_modules/@slop-lab"), { recursive: true }); await mkdir(bin);
  await mkdir(join(config, "dim"), { recursive: true });
  const hostMain = fileURLToPath(new URL("../../../packages/host/core/src/application/host-main.ts", import.meta.url));
  const endpoint = join(bin, "dim-host");
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  await writeFile(endpoint, `#!/bin/sh\nexec ${quote(process.execPath)} --disable-warning=DEP0205 --conditions=dim-source --import ${quote(createRequire(import.meta.url).resolve("tsx"))} ${quote(hostMain)} "$@"\n`, { mode: 0o700 });
  const env = { ...process.env, DIM_HOST_EXECUTABLE: endpoint, DIM_PLUGIN_HOME: plugins, XDG_CONFIG_HOME: config, DIM_DATA_HOME: join(root, "data"), PATH: `${bin}:${process.env.PATH ?? ""}` };
  const run = (args: string[]) => promisify(execFile)(process.execPath, ["--disable-warning=DEP0205", "--conditions=dim-source", "--import", "tsx", cli, ...args], { env, timeout: 10_000 });
  return { root, plugins, config, bin, run, async installLlmPlugin() {
    await symlink(fileURLToPath(new URL("../../../packages/host/plugins/llm-router", import.meta.url)), join(plugins, "node_modules/@slop-lab/dim-host-plugin-llm-router"), "dir");
    await writeFile(join(plugins, "plugins.json"), JSON.stringify({ schemaVersion: 1, plugins: ["@slop-lab/dim-host-plugin-llm-router"] }));
  } };
}
it("discovers commands from an actual installed host plugin in root help without intercepting its own command help", async () => {
  const f = await fixture(); await f.installLlmPlugin();
  const help = await f.run(["--help"]);
  expect(help.stderr).toBe("");
  expect(help.stdout).toContain("Installed host commands:");
  expect(help.stdout).toMatch(/llm-router\s+Inspect and manage an LLM router/);
  expect(help.stdout).toMatch(/llm\s+Connect a host gateway/);
  const feature = await f.run(["llm-router", "--help"]);
  expect(feature.stdout).toContain("dim llm-router OPERATION --connection");
  expect(feature.stdout).toContain("request.cancel");
});
it("keeps the standalone operator executable independent of host and control-plane runtimes", async () => {
  const denyRuntimes = `import { registerHooks } from "node:module";
    registerHooks({ resolve(specifier, context, next) {
      if (specifier.startsWith("@slop-lab/dim-host-core") || specifier.startsWith("@slop-lab/dim-control-plane-")) throw new Error("Operator executable must not load a runtime");
      return next(specifier, context);
    } });`;
  const entrypoint = fileURLToPath(new URL("../../../packages/host/plugins/llm-router/src/operator/main.ts", import.meta.url));
  const result = await promisify(execFile)(process.execPath, ["--disable-warning=DEP0205", "--conditions=dim-source", "--import", "tsx", "--import", `data:text/javascript,${encodeURIComponent(denyRuntimes)}`, entrypoint, "--help"], { timeout: 10_000 });
  expect(result.stdout).toContain("dim llm-router OPERATION");
  expect(result.stderr).toBe("");
});
it("keeps host help clean without optional commands and reports a selected host failure", async () => {
  const f = await fixture();
  const empty = await f.run(["--help"]); expect(empty.stdout).toContain("Persistent, isolated"); expect(empty.stdout).not.toContain("Installed host commands:");
  await writeFile(join(f.config, "dim/hosts.json"), JSON.stringify({ current: "remote", hosts: [{ name: "local" }, { name: "remote", ssh: "fixture-target" }] }));
  await writeFile(join(f.bin, "ssh"), `#!${process.execPath}\n// @ts-check\nconsole.error('fixture host unavailable');process.exit(255);\n`, { mode: 0o700 });
  await expect(f.run(["--host", "remote", "--help"])).rejects.toThrow("fixture host unavailable");
});
it("bounds combined host metadata output before buffering stdout or stderr", async () => {
  const quiet = new Writable({ write(_chunk, _encoding, done) { done(); } });
  for (const stream of ["stdout", "stderr"]) await expect(callHost({ name: "local" }, createHostRequest("capabilities", {}), {
    localCommand: { file: process.execPath, args: ["-e", `process.${stream}.write('x'.repeat(4096));setTimeout(()=>{},30000)`] }, maxOutputBytes: 1024, stderr: quiet
  })).rejects.toThrow("size limit");
});
