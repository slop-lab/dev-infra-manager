import { spawn } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";

const kind = process.argv[2];
const args = process.argv.slice(3);
const mode = process.env.DIM_KVM_PROBE_TEST_MODE ?? "ready";

if (kind === "qemu") runQemu();
else if (kind === "docker") await runDocker();
else process.exit(2);

function runQemu() {
  process.on("SIGTERM", () => process.exit(0));
  process.stdout.write(`${JSON.stringify({ QMP: { version: {}, capabilities: [] } })}\n`);
  const input = createInterface({ input: process.stdin });
  input.on("line", (line) => {
    const command = JSON.parse(line);
    if (command.execute === "qmp_capabilities") {
      process.stdout.write(`${JSON.stringify({ return: {}, id: command.id })}\n`);
    } else if (command.execute === "query-kvm") {
      process.stdout.write(`${JSON.stringify({ return: { enabled: mode !== "disabled", present: true }, id: command.id })}\n`);
    } else if (command.execute === "quit") {
      process.stdout.write(`${JSON.stringify({ return: {}, id: command.id })}\n`, () => {
        if (mode === "valid-hang") setInterval(() => {}, 1_000);
        else process.exit(0);
      });
    }
  });
}

async function runDocker() {
  const statePath = process.env.DIM_KVM_PROBE_CONTAINER_STATE;
  if (statePath === undefined) process.exit(2);
  switch (args[0]) {
    case "run":
      await runContainer(statePath);
      return;
    case "container":
      await containerCommand(statePath);
      return;
    default:
      process.exit(2);
  }
}

async function runContainer(statePath) {
  const name = option("--name");
  const label = option("--label");
  await writeFile(statePath, JSON.stringify({ id: "1".repeat(64), name, label }));
  const commandIndex = args.indexOf("-c");
  if (commandIndex < 0) process.exit(2);
  const childArgs = args.slice(commandIndex);
  childArgs[childArgs.length - 1] = "exec qemu-system-x86_64 -enable-kvm -machine none -nodefaults -display none -qmp stdio";
  const child = spawn("/bin/sh", childArgs, { stdio: "inherit" });
  child.on("exit", (code, signal) => {
    if (mode === "docker-hang") setInterval(() => {}, 1_000);
    else process.exit(code ?? (signal === "SIGKILL" ? 137 : 1));
  });
}

async function containerCommand(statePath) {
  const state = JSON.parse(await readFile(statePath, "utf8"));
  if (args[1] === "inspect") {
    const label = mode === "foreign-label" ? "foreign" : state.label.slice(state.label.indexOf("=") + 1);
    process.stdout.write(`${state.id}|/${state.name}|${label}\n`);
    return;
  }
  if (args[1] === "rm" && args.at(-1) === state.id) {
    if (mode === "cleanup-failure") process.exit(1);
    await rm(statePath);
    return;
  }
  process.exit(1);
}

function option(name) {
  const index = args.indexOf(name);
  const value = args[index + 1];
  if (index < 0 || value === undefined) process.exit(2);
  return value;
}
