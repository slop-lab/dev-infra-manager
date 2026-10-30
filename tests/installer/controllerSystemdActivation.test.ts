import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { managedControllerIsActive } from "../../packages/installer/src/controllerActivation.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const release of cleanup.splice(0).reverse()) await release(); });

async function systemdFixture(command: (runtime: string, pidPath: string) => readonly string[], unsetNodeOptions = true, extra = "") {
  const root = await mkdtemp(path.join(tmpdir(), "dim-installer-systemd-activation-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const runtime = path.join(root, "runtime/current");
  const systemdRuntime = `/run/user/${process.getuid?.()}`;
  const pidPath = path.join(systemdRuntime, "dim/managed/controller.pid");
  const unit = path.join(root, "config/systemd/user/dim-controller.service");
  const bin = path.join(root, "bin");
  await mkdir(runtime, { recursive: true });
  await mkdir(path.dirname(unit), { recursive: true });
  await mkdir(bin);
  await writeFile(unit, `[Service]\nExecStart=${command(runtime, pidPath).map((argument) => JSON.stringify(argument)).join(" ")}\n${unsetNodeOptions ? "UnsetEnvironment=NODE_OPTIONS\n" : ""}${extra}`);
  await writeFile(path.join(bin, "systemctl"), '#!/bin/sh\n[ "$*" = "--user is-active --quiet dim-controller.service" ]\n');
  await chmod(path.join(bin, "systemctl"), 0o755);
  const env = { ...process.env, HOME: root, XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_RUNTIME_DIR: systemdRuntime, DIM_MANAGED_STATE_ROOT: path.join(root, ".local/state/dim/managed"),
    PATH: `${bin}:${process.env.PATH}` };
  return { runtime, pidPath, env };
}

describe("systemd managed controller activation", () => {
  it("detects an active owned unit before its PID file appears", async () => {
    const result = await systemdFixture((runtime, pidPath) => [process.execPath, "--enable-source-maps", "--conditions=dim-source",
      "--disable-warning=DEP0205", path.join(runtime, "node_modules/.bin/dim-host"), "controller", "serve", "--pid-file", pidPath]);
    expect(await managedControllerIsActive(result.runtime, result.env)).toBe(true);
  });

  it.each([
    ["a lookalike entrypoint", (runtime: string, pidPath: string) => [process.execPath, path.join(runtime, "lookalike.mjs"), "controller", "serve", "--pid-file", pidPath]],
    ["Node eval code", (runtime: string, pidPath: string) => [process.execPath, "--eval=0", path.join(runtime, "node_modules/.bin/dim-host"), "controller", "serve", "--pid-file", pidPath]],
    ["a Node preload", (runtime: string, pidPath: string) => [process.execPath, "--import", "data:text/javascript,await%20new%20Promise(()%20=%3E%20{})", path.join(runtime, "node_modules/.bin/dim-host"), "controller", "serve", "--pid-file", pidPath]],
    ["a non-Node executable", (runtime: string, pidPath: string) => ["/bin/sh", path.join(runtime, "node_modules/.bin/dim-host"), "controller", "serve", "--pid-file", pidPath]]
  ])("rejects an active unit with %s", async (_name, command) => {
    const result = await systemdFixture(command);
    expect(await managedControllerIsActive(result.runtime, result.env)).toBe(false);
  });

  it("rejects an active unit that does not clear NODE_OPTIONS", async () => {
    const result = await systemdFixture((runtime, pidPath) => [process.execPath, path.join(runtime, "node_modules/.bin/dim-host"),
      "controller", "serve", "--pid-file", pidPath], false);
    expect(await managedControllerIsActive(result.runtime, result.env)).toBe(false);
  });

  it("rejects a unit with multiple ExecStart directives", async () => {
    const result = await systemdFixture((runtime, pidPath) => [process.execPath, path.join(runtime, "node_modules/.bin/dim-host"),
      "controller", "serve", "--pid-file", pidPath], true, "ExecStart=\"/bin/false\"\n");
    expect(await managedControllerIsActive(result.runtime, result.env)).toBe(false);
  });
});
