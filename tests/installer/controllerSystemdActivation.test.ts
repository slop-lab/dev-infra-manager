import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { managedControllerIsActive } from "../../packages/installer/src/controllerActivation.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const release of cleanup.splice(0).reverse()) await release(); });

function controllerEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of ["NODE_OPTIONS", "LD_PRELOAD", "LD_AUDIT", "LD_LIBRARY_PATH"]) delete env[name];
  return env;
}

function controllerArgs(pidPath: string): string[] {
  const directory = path.dirname(pidPath);
  return ["controller", "serve", "--socket", path.join(directory, "workspace/controller.sock"),
    "--admin-socket", path.join(directory, "admin/controller.sock"), "--pid-file", pidPath];
}

async function systemdFixture(kind: "owned" | "lookalike" | "node-options") {
  const root = await mkdtemp(path.join(tmpdir(), "dim-installer-systemd-activation-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const runtime = path.join(root, "runtime/current");
  const entrypoint = path.join(runtime, "node_modules/.bin/dim-host");
  const lookalike = path.join(runtime, "lookalike.mjs");
  const systemdRuntime = `/run/user/${process.getuid?.()}`;
  const pidPath = path.join(systemdRuntime, "dim/managed/controller.pid");
  const unit = path.join(root, "config/systemd/user/dim-controller.service");
  const bin = path.join(root, "bin");
  await mkdir(path.dirname(entrypoint), { recursive: true });
  await mkdir(path.dirname(unit), { recursive: true });
  await mkdir(bin);
  await writeFile(entrypoint, 'console.log("ready"); setInterval(() => {}, 1000);\n');
  await writeFile(lookalike, 'console.log("ready"); setInterval(() => {}, 1000);\n');
  await writeFile(unit, "[Service]\n");
  const script = kind === "lookalike" ? lookalike : entrypoint;
  const child: ChildProcess = spawn(process.execPath, [script, ...controllerArgs(pidPath)], {
    env: kind === "node-options" ? { ...controllerEnvironment(), NODE_OPTIONS: "--enable-source-maps" } : controllerEnvironment(),
    stdio: ["ignore", "pipe", "inherit"]
  });
  cleanup.push(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit"); child.kill(); await exited;
    }
  });
  if (!child.stdout) throw new Error("missing controller stdout");
  await once(child.stdout, "data");
  await writeFile(path.join(bin, "systemctl"), `#!/bin/sh
if [ "$2" = show ]; then printf '%s\n' ${child.pid ?? 0}; exit 0; fi
[ "$*" = "--user is-active --quiet dim-controller.service" ]
`);
  await chmod(path.join(bin, "systemctl"), 0o755);
  const env = { ...process.env, HOME: root, XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_RUNTIME_DIR: systemdRuntime, DIM_MANAGED_STATE_ROOT: path.join(root, ".local/state/dim/managed"),
    PATH: `${bin}:${process.env.PATH}` };
  return { runtime, env };
}

describe("systemd managed controller activation", () => {
  it("detects the effective owned MainPID before its PID file appears", async () => {
    const result = await systemdFixture("owned");
    expect(await managedControllerIsActive(result.runtime, result.env)).toBe(true);
  });

  it("rejects an active unit whose effective MainPID runs a lookalike", async () => {
    const result = await systemdFixture("lookalike");
    expect(await managedControllerIsActive(result.runtime, result.env)).toBe(false);
  });

  it("rejects an active unit whose effective MainPID inherits NODE_OPTIONS", async () => {
    const result = await systemdFixture("node-options");
    expect(await managedControllerIsActive(result.runtime, result.env)).toBe(false);
  });
});
