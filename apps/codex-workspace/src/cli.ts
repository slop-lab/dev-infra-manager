#!/usr/bin/env node
import { chmod, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { canEnterRunningContainer, containerName, dockerExecArgs, dockerStartArgs, dockerUpdateArgs, statePaths, timedCommand, type ResourceUpdateSelection, type WorkspaceOptions } from "./docker.js";

const argv = process.argv.slice(2);
if (argv[0] === "--") argv.shift();
const action = argv.shift() ?? "help";

function take(flag: string, fallback: string): string {
  const index = argv.indexOf(flag);
  if (index < 0) return fallback;
  const value = argv[index + 1];
  if (!value) throw new Error(`${flag} requires a value`);
  argv.splice(index, 2);
  return value;
}
function has(flag: string): boolean {
  const index = argv.indexOf(flag);
  if (index < 0) return false;
  argv.splice(index, 1);
  return true;
}
function defaults(): WorkspaceOptions {
  const invocationDirectory = path.resolve(process.env.INIT_CWD ?? process.cwd());
  return {
    name: take("--name", path.basename(invocationDirectory).toLowerCase().replace(/[^a-z0-9_.-]+/g, "-") || "workspace"),
    workspace: path.resolve(take("--workspace", invocationDirectory)),
    stateRoot: path.resolve(take("--state-root", process.env.DIM_STATE_ROOT ?? path.join(os.homedir(), ".local/state/dim"))),
    image: take("--image", "dev-infra-codex-workspace:latest"),
    cpus: take("--cpus", "2"), memory: take("--memory", "4g"), pids: take("--pids", "2048"),
    runtime: take("--runtime", "sysbox-runc"),
    timeoutSeconds: Number.parseInt(take("--timeout", "3600"), 10)
  };
}
function run(bin: string, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve(code ?? (signal ? 128 : 1)));
  });
}
async function prepare(options: WorkspaceOptions) {
  const state = statePaths(options);
  await mkdir(state.home, { recursive: true, mode: 0o700 });
  await mkdir(state.docker, { recursive: true, mode: 0o700 });
  await chmod(state.root, 0o700);
  return state;
}
function printHelp() {
  console.log(`dim-codex build|shell|login|run|update|doctor|clean [options] [-- Codex args]

run uses Codex full access inside a Sysbox container. It does not mount the host Docker socket.
Common options: --name NAME --workspace PATH --state-root PATH --cpus 2 --memory 4g
                --pids 2048 --timeout 3600 --runtime sysbox-runc --image IMAGE
Use --yes to acknowledge full Codex access without an interactive confirmation.`);
}

function isContainerRunning(name: string): boolean {
  return spawnSync("docker", ["inspect", "--format", "{{.State.Running}}", containerName(name)], {
    encoding: "utf8"
  }).stdout.trim() === "true";
}

async function main() {
  if (action === "help" || action === "--help") return printHelp();
  const resourceSelection: ResourceUpdateSelection = {
    cpus: argv.includes("--cpus"),
    memory: argv.includes("--memory"),
    pids: argv.includes("--pids")
  };
  const options = defaults();
  if (!Number.isFinite(options.timeoutSeconds) || options.timeoutSeconds < 0) throw new Error("--timeout must be a non-negative integer");
  const yes = has("--yes");
  const imageDir = path.resolve(import.meta.dirname, "../../../images/codex-workspace");
  if (action === "build") {
    process.exitCode = await run("docker", ["build", "--force-rm", "--build-arg", `AGENT_UID=${process.getuid?.() ?? 1000}`, "--build-arg", `AGENT_GID=${process.getgid?.() ?? 1000}`, "-t", options.image, imageDir]);
    return;
  }
  if (action === "doctor") {
    const state = statePaths(options);
    const probe = (args: string[]) => spawnSync("docker", args, { encoding: "utf8" });
    const info = probe(["info", "--format", "{{json .Runtimes}}"]) ;
    const image = probe(["image", "inspect", options.image, "--format", "{{.Id}}"]) ;
    console.log(JSON.stringify({
      docker: info.status === 0,
      sysboxRuntime: info.status === 0 && info.stdout.includes(options.runtime),
      image: image.status === 0,
      hostDockerSocketMounted: false,
      workspace: options.workspace,
      state,
      limits: { cpus: options.cpus, memory: options.memory, pids: options.pids, timeoutSeconds: options.timeoutSeconds },
      diskLimit: { enforced: false, reason: "bind-mounted state requires a quota-capable filesystem or loopback backend" }
    }, null, 2));
    process.exitCode = info.status === 0 && image.status === 0 ? 0 : 1;
    return;
  }
  if (action === "clean") {
    spawnSync("docker", ["rm", "--force", containerName(options.name)], { stdio: "ignore" });
    if (has("--purge")) {
      if (!yes) throw new Error("--purge permanently deletes the dedicated Codex home and inner images; repeat with --yes");
      await rm(statePaths(options).root, { recursive: true, force: true });
    }
    return;
  }
  if (action === "update") {
    if (!isContainerRunning(options.name)) throw new Error(`container ${containerName(options.name)} is not running`);
    if (!resourceSelection.cpus && !resourceSelection.memory && !resourceSelection.pids) {
      throw new Error("update requires at least one of --cpus, --memory, or --pids");
    }
    process.exitCode = await run("docker", dockerUpdateArgs(options, resourceSelection));
    return;
  }
  await prepare(options);
  let command: string[];
  if (action === "shell") command = ["bash", ...argv];
  else if (action === "login") command = ["codex", "login", ...argv];
  else if (action === "run") {
    if (!yes) throw new Error("Codex will have full access inside the isolated container; repeat with --yes to continue");
    command = ["codex", "--dangerously-bypass-approvals-and-sandbox", ...argv.filter((arg) => arg !== "--")];
  } else throw new Error(`unknown action: ${action}`);
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  let running = isContainerRunning(options.name);
  if (running && (resourceSelection.cpus || resourceSelection.memory || resourceSelection.pids)) {
    const updateCode = await run("docker", dockerUpdateArgs(options, resourceSelection));
    if (updateCode !== 0) {
      process.exitCode = updateCode;
      return;
    }
  }
  if (!running && canEnterRunningContainer(action)) {
    const startCode = await run("docker", dockerStartArgs(options));
    if (startCode !== 0) {
      process.exitCode = startCode;
      return;
    }
    running = true;
  }
  if (!running) throw new Error(`container ${containerName(options.name)} is not running`);
  const args = dockerExecArgs(options.name, command, interactive);
  const [bin, timedArgs] = timedCommand(options, args);
  process.exitCode = await run(bin, timedArgs);
}

main().catch((error: unknown) => { console.error(`error: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
