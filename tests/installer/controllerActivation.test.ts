import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { managedControllerIsActive } from "../../packages/installer/src/controllerActivation.js";
import { installHostRuntime } from "../../packages/installer/src/hostRuntimeInstall.js";
import { writeFakeCliNpm, writeStubCli } from "./support.js";
import { readFile } from "node:fs/promises";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const release of cleanup.splice(0).reverse()) await release(); });

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

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "dim-installer-activation-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const runtime = path.join(root, "runtime/current");
  const run = path.join(root, "run/dim/managed");
  await mkdir(runtime, { recursive: true });
  await mkdir(run, { recursive: true });
  return { root, runtime, pidPath: path.join(run, "controller.pid"),
    env: { ...process.env, HOME: root, XDG_CONFIG_HOME: path.join(root, "config"),
      XDG_RUNTIME_DIR: path.join(root, "run"), DIM_MANAGED_STATE_ROOT: path.join(root, ".local/state/dim/managed") } };
}

async function runningFixture(nodeArgs: readonly string[] = [], command: (pidPath: string) => readonly string[] = controllerArgs) {
  const result = await fixture();
  const { runtime, pidPath } = result;
  const script = path.join(runtime, "node_modules/.bin/dim-host");
  await mkdir(path.dirname(script), { recursive: true });
  await writeFile(script, 'import { writeFileSync } from "node:fs"; writeFileSync(process.argv[process.argv.indexOf("--pid-file") + 1], String(process.pid)); console.log("ready"); setInterval(() => {}, 1000);');
  const child: ChildProcess = spawn(process.execPath, [...nodeArgs, script, ...command(pidPath)], {
    env: controllerEnvironment(), stdio: ["ignore", "pipe", "inherit"]
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

  it("recognizes its own controller after supported Node runtime options", async () => {
    const { runtime, env } = await runningFixture([
      "--enable-source-maps", "--conditions=dim-source", "--disable-warning=DEP0205"
    ]);
    expect(await managedControllerIsActive(runtime, env)).toBe(true);
  });

  it.each([
    ["a wrong workspace socket", (pidPath: string) => {
      const args = controllerArgs(pidPath); args[3] = path.join(path.dirname(pidPath), "wrong.sock"); return args;
    }],
    ["trailing transport arguments", (pidPath: string) => [...controllerArgs(pidPath), "--host", "127.0.0.1"]]
  ])("rejects its own entrypoint with %s", async (_name, command) => {
    const { runtime, env } = await runningFixture([], command);
    expect(await managedControllerIsActive(runtime, env)).toBe(false);
  });

  it("automatically restarts an active installation and restores its prior runtime when readiness fails", async () => {
    const { root, runtime, env } = await runningFixture();
    for (const name of ["HOME", "XDG_CONFIG_HOME", "XDG_RUNTIME_DIR", "DIM_MANAGED_STATE_ROOT"] as const) vi.stubEnv(name, env[name]);
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
    for (const name of ["HOME", "XDG_CONFIG_HOME", "XDG_RUNTIME_DIR", "DIM_MANAGED_STATE_ROOT"] as const) vi.stubEnv(name, env[name]);
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

  it("rejects a lookalike controller process under the installation directory", async () => {
    const { runtime, pidPath, env } = await fixture();
    const script = path.join(runtime, "lookalike.mjs");
    await writeFile(script, 'import { writeFileSync } from "node:fs"; writeFileSync(process.argv[process.argv.indexOf("--pid-file") + 1], String(process.pid)); console.log("ready"); setInterval(() => {}, 1000);');
    const child = spawn(process.execPath, [script, ...controllerArgs(pidPath)], {
      env: controllerEnvironment(), stdio: ["ignore", "pipe", "inherit"]
    });
    cleanup.push(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit"); child.kill(); await exited;
      }
    });
    await once(child.stdout!, "data");
    expect(await managedControllerIsActive(runtime, env)).toBe(false);
  });

  it("rejects an expected entrypoint passed as an argument to a lookalike process", async () => {
    const { runtime, pidPath, env } = await fixture();
    const script = path.join(runtime, "lookalike.mjs");
    const expected = path.join(runtime, "node_modules/.bin/dim-host");
    await writeFile(script, 'import { writeFileSync } from "node:fs"; writeFileSync(process.argv[process.argv.indexOf("--pid-file") + 1], String(process.pid)); console.log("ready"); setInterval(() => {}, 1000);');
    const child = spawn(process.execPath, [script, expected, ...controllerArgs(pidPath)], {
      env: controllerEnvironment(), stdio: ["ignore", "pipe", "inherit"]
    });
    cleanup.push(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit"); child.kill(); await exited;
      }
    });
    await once(child.stdout!, "data");
    expect(await managedControllerIsActive(runtime, env)).toBe(false);
  });

  it("rejects an expected entrypoint passed after Node eval code", async () => {
    const { runtime, pidPath, env } = await fixture();
    const expected = path.join(runtime, "node_modules/.bin/dim-host");
    const code = 'require("node:fs").writeFileSync(process.argv[process.argv.indexOf("--pid-file") + 1], String(process.pid)); console.log("ready"); setInterval(() => {}, 1000);';
    const child = spawn(process.execPath, [`--eval=${code}`, expected, ...controllerArgs(pidPath)], {
      env: controllerEnvironment(), stdio: ["ignore", "pipe", "inherit"]
    });
    cleanup.push(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit"); child.kill(); await exited;
      }
    });
    await once(child.stdout!, "data");
    expect(await managedControllerIsActive(runtime, env)).toBe(false);
  });

  it("rejects an expected entrypoint after a Node preload blocks script execution", async () => {
    const { runtime, pidPath, env } = await fixture();
    const expected = path.join(runtime, "node_modules/.bin/dim-host");
    const preload = `data:text/javascript,${encodeURIComponent(`
      import { writeFileSync } from "node:fs";
      writeFileSync(process.argv[process.argv.indexOf("--pid-file") + 1], String(process.pid));
      console.log("ready");
      await new Promise(() => {});
    `)}`;
    const child = spawn(process.execPath, ["--import", preload, expected, ...controllerArgs(pidPath)], {
      env: controllerEnvironment(), stdio: ["ignore", "pipe", "inherit"]
    });
    cleanup.push(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit"); child.kill(); await exited;
      }
    });
    await once(child.stdout!, "data");
    expect(await managedControllerIsActive(runtime, env)).toBe(false);
  });

  it("rejects an expected entrypoint when NODE_OPTIONS preloads code", async () => {
    const { runtime, pidPath, env } = await fixture();
    const expected = path.join(runtime, "node_modules/.bin/dim-host");
    await mkdir(path.dirname(expected), { recursive: true });
    await writeFile(expected, "setInterval(() => {}, 1000);\n");
    const preload = `data:text/javascript,${encodeURIComponent(`
      import { writeFileSync } from "node:fs";
      writeFileSync(process.argv[process.argv.indexOf("--pid-file") + 1], String(process.pid));
      console.log("ready");
      await new Promise(() => {});
    `)}`;
    const child = spawn(process.execPath, [expected, ...controllerArgs(pidPath)], {
      env: { ...controllerEnvironment(), NODE_OPTIONS: `--import=${preload}` }, stdio: ["ignore", "pipe", "inherit"]
    });
    cleanup.push(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit"); child.kill(); await exited;
      }
    });
    await once(child.stdout!, "data");
    expect(await managedControllerIsActive(runtime, env)).toBe(false);
  });

  it("rejects an expected entrypoint with dynamic-loader environment", async () => {
    const { runtime, pidPath, env } = await fixture();
    const expected = path.join(runtime, "node_modules/.bin/dim-host");
    await mkdir(path.dirname(expected), { recursive: true });
    await writeFile(expected, 'import { writeFileSync } from "node:fs"; writeFileSync(process.argv[process.argv.indexOf("--pid-file") + 1], String(process.pid)); console.log("ready"); setInterval(() => {}, 1000);\n');
    const child = spawn(process.execPath, [expected, ...controllerArgs(pidPath)], {
      env: { ...controllerEnvironment(), LD_LIBRARY_PATH: "/tmp" }, stdio: ["ignore", "pipe", "inherit"]
    });
    cleanup.push(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit"); child.kill(); await exited;
      }
    });
    await once(child.stdout!, "data");
    expect(await managedControllerIsActive(runtime, env)).toBe(false);
  });

  it("rejects a non-Node executable with exact controller arguments", async () => {
    const { runtime, pidPath, env } = await fixture();
    const expected = path.join(runtime, "node_modules/.bin/dim-host");
    await mkdir(path.dirname(expected), { recursive: true });
    await writeFile(expected, '#!/bin/sh\nprintf "%s" "$$" > "$8"\nprintf "ready\\n"\nwhile :; do sleep 1; done\n');
    const child = spawn("/bin/sh", [expected, ...controllerArgs(pidPath)], {
      env: controllerEnvironment(), stdio: ["ignore", "pipe", "inherit"]
    });
    cleanup.push(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit"); child.kill(); await exited;
      }
    });
    await once(child.stdout!, "data");
    expect(await managedControllerIsActive(runtime, env)).toBe(false);
  });

});
