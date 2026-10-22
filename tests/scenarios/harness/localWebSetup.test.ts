import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { configureLocalWeb } from "../../../scripts/configure-local-web.ts";
import { defaultWebPluginPackages } from "../../../scripts/local-web-profile.ts";
import { ownedWebUnit, webUnitPath } from "../../../scripts/local-uninstall/web-unit.ts";
import { removalPaths } from "../../../scripts/local-uninstall/paths.ts";
import { createRemovalPlan, executeRemoval } from "../../../scripts/local-uninstall/plan.ts";
import type { Command } from "../../../scripts/local-uninstall/command.ts";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "dim-local-web-")); roots.push(home);
  const env = { HOME: home, XDG_RUNTIME_DIR: join(home, "run"), PATH: "/usr/bin" }, paths = removalPaths(env);
  await mkdir(dirname(paths.config), { recursive: true, mode: 0o700 });
  await writeFile(paths.config, JSON.stringify({ cli: { executable: join(paths.data, "runtime/current/node_modules/.bin/dim") } }), { mode: 0o600 });
  const calls: string[][] = [];
  const run: Command = async (file, args) => {
    calls.push([file, ...args]);
    if (args.includes("init-operations")) {
      await writeFile(args[args.indexOf("--output") + 1]!, JSON.stringify({ publicOrigin: "http://127.0.0.1:9081", accounts: [{ passwordHash: "unchanged" }] }), { flag: "wx", mode: 0o600 });
      return { status: 0, stdout: "Browser username: operator\nBrowser password: private-password\n", stderr: "" };
    }
    return { status: 0, stdout: file === "mise" ? "[]" : "", stderr: "" };
  };
  return { paths, env, run, calls };
}
it("sets up a persistent local UI without printing credentials or resetting accounts on repeated installation", async () => {
  const f = await fixture();
  await configureLocalWeb(f.env, f.run);
  expect(await ownedWebUnit(f.paths)).toBe(true);
  const config = join(f.paths.configuration, "web/config.json"), before = await readFile(config, "utf8");
  await configureLocalWeb(f.env, f.run);
  expect(await readFile(config, "utf8")).toBe(before);
  expect(f.calls.filter((args) => args.includes("init-operations"))).toHaveLength(1);
  expect(await readFile(join(f.paths.configuration, "web/login.txt"), "utf8")).toContain("private-password");
  expect(f.calls).toContainEqual(["systemctl", "--user", "restart", "dim-web.service"]);
  const saved = JSON.parse(before);
  expect(saved.plugins).toEqual(defaultWebPluginPackages.map((packageName) => ({ package: packageName })));
  const operations = JSON.parse(await readFile(join(f.paths.configuration, "web/operations.json"), "utf8"));
  expect(operations.hosts[0].selector).toBe("local");
});
it("disables and removes the owned Web service during local uninstall", async () => {
  const f = await fixture(); await configureLocalWeb(f.env, f.run);
  const plan = await createRemovalPlan(f.paths, f.run, f.env);
  expect(plan.webUnit).toBe(true);
  await executeRemoval(plan, f.run);
  expect(f.calls).toContainEqual(["systemctl", "--user", "disable", "--now", "dim-web.service"]);
  await expect(readFile(webUnitPath(f.paths))).rejects.toMatchObject({ code: "ENOENT" });
});
it("leaves a foreign service untouched", async () => {
  const f = await fixture();
  await mkdir(dirname(webUnitPath(f.paths)), { recursive: true, mode: 0o700 });
  await writeFile(webUnitPath(f.paths), "[Service]\nExecStart=/foreign/server\n");
  await expect(configureLocalWeb(f.env, f.run)).rejects.toThrow("does not belong");
  expect(await readFile(webUnitPath(f.paths), "utf8")).toContain("/foreign/server");
  expect(f.calls.some((args) => args.includes("restart"))).toBe(false);
});
it("initializes private access without requiring user systemd", async () => {
  const f = await fixture();
  const run: Command = (file, args) => file === "systemctl"
    ? Promise.resolve({ status: 1, stdout: "", stderr: "no user bus" }) : f.run(file, args);
  await configureLocalWeb(f.env, run);
  expect(await readFile(join(f.paths.configuration, "web/login.txt"), "utf8")).toContain("Browser username: operator");
  expect(await ownedWebUnit(f.paths)).toBe(false);
  expect(f.calls.some((args) => args.includes("restart"))).toBe(false);
});

it("uses controller discovery rather than pinning the Web server router file, preserving explicit selections", async () => {
  const f = await fixture();
  const llm = join(f.paths.configuration, "llm");
  await mkdir(llm, { mode: 0o700 });
  const connectionFile = join(llm, "operator.json");
  await writeFile(connectionFile, "{}", { mode: 0o600 });
  await configureLocalWeb(f.env, f.run);
  const file = join(f.paths.configuration, "web/config.json");
  const saved = JSON.parse(await readFile(file, "utf8"));
  expect(saved.plugins[0]).toEqual({ package: defaultWebPluginPackages[0] });
  saved.plugins = [
    { package: defaultWebPluginPackages[0], config: { connectionFile: "/operator/other-router.json" } },
    { package: "@operator/custom-plugin", config: { privateValue: "preserve" } }
  ];
  await writeFile(file, JSON.stringify(saved));
  await configureLocalWeb(f.env, f.run);
  const updated = JSON.parse(await readFile(file, "utf8"));
  expect(updated.accounts).toEqual(saved.accounts);
  expect(updated.plugins.slice(0, 2)).toEqual(saved.plugins);
  expect(updated.plugins.slice(2)).toEqual(defaultWebPluginPackages.slice(1).map((packageName) => ({ package: packageName })));
  const before = await readFile(file, "utf8");
  await configureLocalWeb(f.env, f.run);
  expect(await readFile(file, "utf8")).toBe(before);
});

it("does not inspect an unrelated Web-server router file when controllers own the selection", async () => {
  const f = await fixture();
  const llm = join(f.paths.configuration, "llm");
  await mkdir(llm, { mode: 0o700 });
  await writeFile(join(llm, "operator.json"), "{}", { mode: 0o644 });
  await configureLocalWeb(f.env, f.run);
  const saved = JSON.parse(await readFile(join(f.paths.configuration, "web/config.json"), "utf8"));
  expect(saved.plugins[0]).toEqual({ package: defaultWebPluginPackages[0] });
  expect(f.calls.some((args) => args.includes("restart"))).toBe(true);
});
