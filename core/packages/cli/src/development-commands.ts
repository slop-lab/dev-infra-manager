import { createInterface } from "node:readline/promises";
import { type Command } from "commander";
import { UserError, type WorkspaceRecord, type WorkspaceView } from "@slop-lab/dim-core/workspace";
import { HostContextStore, type HostTarget } from "./host-context.js";
import { callHost, streamHost } from "./host-transport.js";
import { forwardWorkspace } from "./port-forward.js";
import { createWorkspaceWithPlugins } from "./workspace-create-client.js";

interface OutputFlags { json?: boolean; expectId?: string }
interface CreateFlags extends OutputFlags {
  repository?: string[];
  workdir?: string;
  ref?: string;
  image?: string;
  runtime?: string;
  cpus?: string;
  memory?: string;
  pids?: string;
  gitUserName?: string;
  gitUserEmail?: string;
}

export function registerDevelopmentCommands(program: Command): void {
  const hosts = new HostContextStore();
  registerHostContexts(program, hosts);
  program.command("plugins").description("List optional commands and runtimes installed on the selected host")
    .action(async (_flags: unknown, command: Command) => {
      console.log(JSON.stringify(await callHost(await selectedHost(command, hosts), { operation: "plugins" }), null, 2));
    });
  program.command("doctor")
    .description("Check development host readiness")
    .option("--json", "print JSON")
    .action(async (flags: OutputFlags, command: Command) => {
      const checks = await callHost<Array<{ name: string; ok: boolean; detail: string }>>(
        await selectedHost(command, hosts), { operation: "doctor" }
      );
      if (flags.json) console.log(JSON.stringify(checks));
      else for (const check of checks) console.log(`${check.ok ? "ok" : "fail"}\t${check.name}\t${check.detail}`);
      if (checks.some((check) => !check.ok)) process.exitCode = 2;
    });
  const workspace = program.command("workspace").description("Manage persistent development workspaces");
  for (const parent of [program, workspace]) registerWorkspaceOperations(parent, hosts);
}

function registerWorkspaceOperations(parent: Command, hosts: HostContextStore): void {
  parent.command("connect")
    .description("Connect standard input/output to a workspace loopback TCP port")
    .argument("<name>")
    .argument("<port>")
    .action(async (name: string, port: string, _flags: unknown, command: Command) => {
      const remotePort = portNumber(port);
      const target = await selectedHost(command, hosts);
      await withConnectionSignals(async (signal) => {
        process.exitCode = await streamHost(target, { operation: "connect", input: { name, port: remotePort } }, {
          terminal: false, signal, stdin: process.stdin, stdout: process.stdout, stderr: process.stderr
        });
      });
    });

  parent.command("forward")
    .description("Forward a client loopback port to a workspace loopback TCP port")
    .argument("<name>")
    .argument("<local:remote>", "use local port 0 to select an available port")
    .action(async (name: string, ports: string, _flags: unknown, command: Command) => {
      const match = /^(\d+):(\d+)$/.exec(ports);
      if (!match) throw new UserError("forward requires LOCAL:REMOTE ports, such as 3000:3000");
      const localPort = portNumber(match[1]!, true), remotePort = portNumber(match[2]!);
      const target = await selectedHost(command, hosts);
      await withConnectionSignals((signal) => forwardWorkspace(target, name, localPort, remotePort, {
        signal,
        onListening: (port) => process.stderr.write(`Forwarding 127.0.0.1:${port} to ${target.name}/${name}:127.0.0.1:${remotePort}\n`)
      }));
    });

  parent.command("image").description("Manage workspace images on the selected host")
    .command("build")
    .description("Build the default development workspace image")
    .option("--image <image>", "image name to build")
    .option("--json", "print JSON")
    .action(async (flags: OutputFlags & { image?: string }, command: Command) => {
      const target = await selectedHost(command, hosts);
      const result = await callHost<{ image: string }>(target, {
        operation: "image.build", input: flags.image === undefined ? {} : { image: flags.image }
      });
      printAction(result, flags, `Built workspace image '${result.image}' on '${target.name}'`);
    });

  parent.command("create")
    .description("Create an isolated workspace from a Git URL or path on the selected host")
    .argument("<source>")
    .argument("<name>")
    .option("--ref <ref>", "source branch, tag or commit")
    .option("--repository <id>", "select a managed repository (repeat for multiple)", (value: string, selected: string[]) => [...selected, value], [])
    .option("--workdir <id>", "selected managed repository used as the working directory")
    .option("--image <image>", "workspace image")
    .option("--runtime <name>", "workspace runtime (container by default; optional providers come from plugins)")
    .option("--cpus <count>", "workspace CPU limit")
    .option("--memory <size>", "workspace memory limit")
    .option("--pids <count>", "workspace process limit")
    .option("--git-user-name <name>", "Git author name")
    .option("--git-user-email <email>", "Git author email")
    .option("--json", "print JSON")
    .action(async (source: string, name: string, flags: CreateFlags, command: Command) => {
      if (!source.trim()) throw new UserError("provide a Git source URL or path on the selected host");
      if (Boolean(flags.gitUserName) !== Boolean(flags.gitUserEmail)) {
        throw new UserError("--git-user-name and --git-user-email must be provided together");
      }
      const target = await selectedHost(command, hosts);
      const record = await withConnectionSignals((signal) => createWorkspaceWithPlugins(target, {
        name,
        ...(flags.repository?.length ? { repositories: flags.repository } : {}),
        ...(flags.workdir === undefined ? {} : { workingDirectory: flags.workdir }),
        source: { url: source, ...(flags.ref === undefined ? {} : { ref: flags.ref }) },
        ...(flags.image === undefined ? {} : { image: flags.image }),
        ...(flags.runtime === undefined ? {} : { runtime: flags.runtime }),
        ...resourceInput(flags),
        ...(flags.gitUserName && flags.gitUserEmail ? { git: { name: flags.gitUserName, email: flags.gitUserEmail } } : {})
      }, {
        signal,
        ...(process.stdin.isTTY && process.stderr.isTTY ? { approve: async (required, host) => {
          const prompt = createInterface({ input: process.stdin, output: process.stderr });
          try {
            const answer = await prompt.question(`Repository ${required.source.url}\nCommit ${required.source.commit}\nInstall and enable host code on '${host.name}':\n  ${required.plugins.join("\n  ")}\nApprove plugin installation? [y/N] `, { signal });
            return /^y(?:es)?$/i.test(answer.trim());
          } finally { prompt.close(); }
        } } : {})
      }));
      if (record) printAction(record, flags, `Workspace '${record.name}' is ready on '${target.name}'`);
    });

  parent.command("list").alias("ls")
    .description("List workspaces on the selected host")
    .option("--json", "print JSON")
    .action(async (flags: OutputFlags, command: Command) => {
      const records = await callHost<WorkspaceView[]>(await selectedHost(command, hosts), { operation: "list" });
      if (flags.json) console.log(JSON.stringify(records));
      else if (records.length === 0) console.log("No workspaces");
      else {
        console.log("NAME\tSTATUS\tSOURCE");
        for (const record of records) console.log(`${record.name}\t${workspaceStatus(record)}\t${record.source.url}`);
      }
    });

  parent.command("show")
    .description("Show a workspace")
    .argument("<name>")
    .option("--json", "print JSON")
    .action(async (name: string, flags: OutputFlags, command: Command) => {
      const record = await callHost<WorkspaceView>(await selectedHost(command, hosts), { operation: "show", input: { name } });
      if (flags.json) console.log(JSON.stringify(record));
      else {
        console.log(`${record.name}\t${workspaceStatus(record)}`);
        if (record.runtimeError) console.log(`Runtime: ${record.runtimeError}`);
        console.log(`Source: ${record.source.url} (${record.source.ref})`);
        console.log(`Image: ${record.image}`);
        console.log(`Resources: ${record.resources.cpuCount} CPUs, ${record.resources.memory} memory, ${record.resources.pidsLimit} PIDs`);
      }
    });

  for (const operation of ["start", "stop", "restart", "recreate"] as const) {
    parent.command(operation)
      .description(operation === "recreate" ? "Replace a workspace container while preserving its checkout, home and Docker data" : `${capitalize(operation)} a workspace`)
      .argument("<name>")
      .option("--json", "print JSON")
      .option("--expect-id <uuid>", "reject a workspace replaced since it was selected")
      .action(async (name: string, flags: OutputFlags, command: Command) => {
        const record = await callHost<WorkspaceRecord>(await selectedHost(command, hosts), { operation, input: { name, ...(flags.expectId === undefined ? {} : { expectedId: flags.expectId }) } });
        printAction(record, flags, `Workspace '${record.name}' is ${record.phase}`);
      });
  }

  parent.command("resources")
    .description("Update resource limits for a workspace")
    .argument("<name>")
    .option("--cpus <count>", "workspace CPU limit")
    .option("--memory <size>", "workspace memory limit")
    .option("--pids <count>", "workspace process limit")
    .option("--json", "print JSON")
    .option("--expect-id <uuid>", "reject a workspace replaced since it was selected")
    .action(async (name: string, flags: CreateFlags, command: Command) => {
      const resources = resourceInput(flags).resources;
      if (resources === undefined) throw new UserError("provide at least one resource limit");
      const outcome = await callHost<{ workspace: WorkspaceRecord; recreated: boolean }>(await selectedHost(command, hosts), {
        operation: "resources", input: { name, resources, ...(flags.expectId === undefined ? {} : { expectedId: flags.expectId }) }
      });
      printAction(outcome, flags, `Updated resources for workspace '${outcome.workspace.name}'`
        + (outcome.recreated ? " (container recreated; persistent data preserved)" : ""));
    });

  parent.command("discard")
    .description("Delete a workspace and all its checkout, home and Docker data")
    .argument("<name>")
    .option("--yes", "confirm permanent deletion")
    .option("--json", "print JSON")
    .option("--expect-id <uuid>", "reject a workspace replaced since it was selected")
    .action(async (name: string, flags: OutputFlags & { yes?: boolean }, command: Command) => {
      const target = await selectedHost(command, hosts);
      if (!flags.yes) {
        if (!interactive()) throw new UserError("confirmation requires --yes in a non-interactive shell");
        const reader = createInterface({ input: process.stdin, output: process.stdout });
        try {
          const answer = await reader.question(`Permanently delete workspace '${name}' and all its data on '${target.name}'? [y/N] `);
          if (!/^y(?:es)?$/i.test(answer.trim())) throw new UserError("operation was not confirmed");
        } finally { reader.close(); }
      }
      const result = await callHost(target, { operation: "discard", input: { name, ...(flags.expectId === undefined ? {} : { expectedId: flags.expectId }) } });
      printAction(result, flags, `Discarded workspace '${name}'`);
    });

  parent.command("shell")
    .description("Open a shell in the workspace")
    .argument("<name>")
    .action(async (name: string, _flags: unknown, command: Command) => execute(command, hosts, name, ["bash", "-l"]));

  for (const operation of ["exec", "run"] as const) {
    parent.command(operation)
      .description(operation === "exec" ? "Execute a command in the workspace" : "Run a command; no command opens a shell")
      .argument("<name>")
      .argument(operation === "exec" ? "<command...>" : "[command...]")
      .allowUnknownOption()
      .action(async (name: string, arguments_: string[], _flags: unknown, command: Command) => {
        let argumentsToRun = arguments_;
        if (operation === "run") {
          if (arguments_.length === 0 || arguments_[0] === "shell") {
            if (arguments_.length > 1) throw new UserError("run shell accepts no command arguments; use run exec instead");
            argumentsToRun = ["bash", "-l"];
          } else if (arguments_[0] === "exec" || arguments_[0] === "custom") {
            argumentsToRun = arguments_.slice(1);
            if (argumentsToRun.length === 0) throw new UserError("provide a command after run exec or run custom");
          }
        }
        await execute(command, hosts, name, argumentsToRun);
      });
  }
}

function registerHostContexts(program: Command, hosts: HostContextStore): void {
  const host = program.command("host").description("Configure local and SSH development hosts");
  host.command("add").argument("<name>").requiredOption("--ssh <target>", "SSH config name or user@host")
    .action(async (name: string, flags: { ssh: string }) => {
      await hosts.add({ name, ssh: flags.ssh });
      console.log(`Added host '${name}'; select it with 'dim host use ${name}'`);
    });
  host.command("list").alias("ls").option("--json", "print JSON")
    .action(async (flags: OutputFlags) => {
      const targets = await hosts.list();
      if (flags.json) console.log(JSON.stringify(targets));
      else for (const target of targets) console.log(`${target.current ? "*" : " "} ${target.name}\t${target.ssh ?? "local"}`);
    });
  host.command("use").argument("<name>").action(async (name: string) => {
    await hosts.use(name);
    console.log(`Selected host '${name}'`);
  });
  host.command("remove").argument("<name>").action(async (name: string) => {
    await hosts.remove(name);
    console.log(`Removed host '${name}'`);
  });
}

async function selectedHost(command: Command, hosts: HostContextStore): Promise<HostTarget> {
  return hosts.resolve(command.optsWithGlobals<{ host?: string }>().host);
}

async function execute(command: Command, hosts: HostContextStore, name: string, arguments_: string[]): Promise<void> {
  const terminal = interactive();
  process.exitCode = await streamHost(await selectedHost(command, hosts), {
    operation: "exec", input: { name, command: arguments_, interactive: terminal }
  }, { terminal });
}

function resourceInput(flags: CreateFlags): { resources?: { cpuCount?: string; memory?: string; pidsLimit?: string } } {
  if (flags.cpus === undefined && flags.memory === undefined && flags.pids === undefined) return {};
  return { resources: {
    ...(flags.cpus === undefined ? {} : { cpuCount: flags.cpus }),
    ...(flags.memory === undefined ? {} : { memory: flags.memory }),
    ...(flags.pids === undefined ? {} : { pidsLimit: flags.pids })
  } };
}

function printAction(record: unknown, flags: OutputFlags, message: string): void {
  console.log(flags.json ? JSON.stringify(record) : message);
}

function interactive(): boolean { return Boolean(process.stdin.isTTY && process.stdout.isTTY); }
function capitalize(value: string): string { return value[0]?.toUpperCase() + value.slice(1); }

function workspaceStatus(record: WorkspaceView): string {
  const observed = record.runtimeStatus ?? record.phase;
  return observed === record.phase ? record.phase : `${record.phase}/${observed}`;
}

function portNumber(value: string, allowZero = false): number {
  const port = /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(port) || port < (allowZero ? 0 : 1) || port > 65535) {
    throw new UserError(`port must be an integer between ${allowZero ? 0 : 1} and 65535`);
  }
  return port;
}

async function withConnectionSignals<T>(action: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> {
  const abort = new AbortController();
  let signalCode: number | undefined;
  const stop = (signal: NodeJS.Signals) => {
    signalCode = signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 129;
    abort.abort();
  };
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  for (const signal of signals) process.once(signal, stop);
  try { return await action(abort.signal); }
  catch (error) { if (!abort.signal.aborted) throw error; }
  finally {
    for (const signal of signals) process.off(signal, stop);
    if (signalCode !== undefined) process.exitCode = signalCode;
  }
}
