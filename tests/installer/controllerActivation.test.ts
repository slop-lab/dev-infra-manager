import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { managedControllerIsActive } from "../../packages/installer/src/controllerActivation.js";
import { installHostRuntime } from "../../packages/installer/src/hostRuntimeInstall.js";
import { writeFakeCliNpm, writeStubCli } from "./support.js";
import { readFile } from "node:fs/promises";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const release of cleanup.splice(0).reverse()) await release(); });

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "dim-installer-activation-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const runtime = path.join(root, "runtime/current");
  const run = path.join(root, "run/dim");
  await mkdir(runtime, { recursive: true });
  await mkdir(run, { recursive: true });
  return { root, runtime, pidPath: path.join(run, "controller.pid"),
    env: { ...process.env, HOME: root, XDG_CONFIG_HOME: path.join(root, "config"),
      XDG_RUNTIME_DIR: path.join(root, "run"), DIM_STATE_ROOT: path.join(root, ".local/state/dim") } };
}

async function runningFixture() {
  const result = await fixture();
  const { runtime, pidPath } = result;
  const script = path.join(runtime, "controller.mjs");
  await writeFile(script, 'import { writeFileSync } from "node:fs"; writeFileSync(process.argv[process.argv.indexOf("--pid-file") + 1], String(process.pid)); console.log("ready"); setInterval(() => {}, 1000);');
  const child: ChildProcess = spawn(process.execPath, [script, "controller", "serve", "--pid-file", pidPath], {
    stdio: ["ignore", "pipe", "inherit"]
  });
  cleanup.push(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit"); child.kill(); await exited;
    }
  });
  await once(child.stdout!, "data");
  return result;
}

describe("existing managed controller activation", () => {
  it("does not require a controller or host backend configuration for a base install", async () => {
    const { runtime, env } = await fixture();
    expect(await managedControllerIsActive(runtime, env)).toBe(false);
  });

  it("recognizes its own running controller and excludes another installation", async () => {
    const { runtime, env } = await runningFixture();
    expect(await managedControllerIsActive(runtime, env)).toBe(true);
    expect(await managedControllerIsActive(path.join(runtime, "another-install"), env)).toBe(false);
  });

  it("automatically restarts an active installation and restores its prior runtime when readiness fails", async () => {
    const { root, runtime, env } = await runningFixture();
    for (const name of ["HOME", "XDG_CONFIG_HOME", "XDG_RUNTIME_DIR", "DIM_STATE_ROOT"] as const) vi.stubEnv(name, env[name]);
    const previous = path.join(runtime, "node_modules/.bin/dim-host");
    const priorCalls = path.join(root, "prior-calls.json");
    const targetCalls = path.join(root, "target-calls.json");
    await mkdir(path.dirname(previous), { recursive: true });
    await writeStubCli(previous, { versionOutput: "1.0.0", echoFile: priorCalls });
    const npm = path.join(root, "npm.mjs");
    await writeFakeCliNpm(npm, { argsFile: path.join(root, "npm-args.json"), versionOutput: "2.0.0",
      controllerArgsFile: targetCalls, controllerExitCode: 9 });
    await expect(installHostRuntime({ version: "2.0.0", packageSpecifiers: ["@slop-lab/dim-host-core@2.0.0"], npmCommand: npm,
      dataHome: root, configPath: path.join(root, "config.json") })).rejects.toThrow(/controller restart/);
    expect(JSON.parse(await readFile(targetCalls, "utf8"))).toEqual([["controller", "restart"]]);
    expect(JSON.parse(await readFile(priorCalls, "utf8"))).toMatchObject({ argv: ["controller", "restart"] });
  });

  it.each([undefined, false])("upgrades the generic controller without optional integrations (restart=%s)", async (restartController) => {
    const { root, runtime, env } = await runningFixture();
    for (const name of ["HOME", "XDG_CONFIG_HOME", "XDG_RUNTIME_DIR", "DIM_STATE_ROOT"] as const) vi.stubEnv(name, env[name]);
    const previous = path.join(runtime, "node_modules/.bin/dim-host");
    await mkdir(path.dirname(previous), { recursive: true });
    await writeStubCli(previous, { versionOutput: "1.0.0" });
    const configPath = path.join(root, "dim-config.json");
    await writeFile(configPath, JSON.stringify({ schemaVersion: 1, custom: "retained" }));
    const targetCalls = path.join(root, "target-calls.json");
    const argsFile = path.join(root, "args.json"), npm = path.join(root, "npm.mjs");
    await writeFakeCliNpm(npm, { argsFile, versionOutput: "2.0.0", controllerArgsFile: targetCalls });
    await installHostRuntime({ version: "2.0.0", npmCommand: npm, dataHome: root, configPath,
      ...(restartController === undefined ? {} : { restartController })});
    expect(JSON.parse(await readFile(argsFile, "utf8"))).toContain("@slop-lab/dim-host-core@2.0.0");
    expect(JSON.parse(await readFile(argsFile, "utf8"))).not.toContain("@slop-lab/dim-control-plane-admin@2.0.0");
    expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({ custom: "retained", host: { version: "2.0.0" } });
    if (restartController === false) await expect(readFile(targetCalls)).rejects.toMatchObject({ code: "ENOENT" });
    else expect(JSON.parse(await readFile(targetCalls, "utf8"))).toEqual([["controller","restart"]]);
  });

  it("does not mistake a recycled PID marker for a managed controller", async () => {
    const { runtime, pidPath, env } = await fixture();
    await writeFile(pidPath, String(process.pid));
    expect(await managedControllerIsActive(runtime, env)).toBe(false);
  });

  it("detects an already active owned systemd unit before its PID file appears", async () => {
    const { root, runtime, env } = await fixture();
    const unit = path.join(env.XDG_CONFIG_HOME, "systemd/user/dim-controller.service");
    const bin = path.join(root, "bin");
    await mkdir(path.dirname(unit), { recursive: true });
    await mkdir(bin);
    await writeFile(unit, `[Service]\nExecStart=${runtime}/node_modules/.bin/dim controller serve\n`);
    await writeFile(path.join(bin, "systemctl"), '#!/bin/sh\n[ "$*" = "--user is-active --quiet dim-controller.service" ]\n');
    await chmod(path.join(bin, "systemctl"), 0o755);
    expect(await managedControllerIsActive(runtime, { ...env, XDG_RUNTIME_DIR: `/run/user/${process.getuid?.()}`,
      PATH: `${bin}:${process.env.PATH}` })).toBe(true);
  });
});
