#!/usr/bin/env node
import { Command, CommanderError } from "commander";
import { CliHostProtocolError, cliHostProtocol, createHostRequest } from "@slop-lab/dim-contracts-cli-host";
import { HostContextError, HostContextStore } from "./host-context.js";
import { HostTransportError, negotiateHost, streamHost } from "./host-transport.js";
import { forwardWorkspace } from "./port-forward.js";
import { packageVersion } from "./package-version.js";

let signalExitCode: number | undefined;
try {
  const args = process.argv.slice(process.argv[2] === "--" ? 3 : 2);
  if (args.length === 1 && ["--version", "-V"].includes(args[0]!)) console.log(packageVersion);
  else if (args.length === 1 && args[0] === "--host-protocol") {
    console.log(JSON.stringify({ protocol: cliHostProtocol, versions: [1] }));
  } else {
    const selected = hostArguments(args), hosts = new HostContextStore();
    if (selected.args[0] === "host") await clientHostCommands(hosts).parseAsync(selected.args, { from: "user" });
    else {
      const target = await hosts.resolve(selected.host);
      await withSignals(async (signal) => {
        const command = selected.args[0] === "workspace" ? selected.args.slice(1) : selected.args;
        if (command[0] === "forward") {
          const program = new Command().name("dim").exitOverride();
          program.command("forward").argument("<workspace>").argument("<local:remote>")
            .action(async (name: string, ports: string) => {
              const match = /^(\d+):(\d+)$/.exec(ports);
              if (!match) throw new CliHostProtocolError("forward requires LOCAL:REMOTE ports, such as 3000:3000");
              const local = port(match[1]!, true), remote = port(match[2]!);
              await forwardWorkspace(target, name, local, remote, { signal,
                onListening: (bound) => process.stderr.write(`Forwarding 127.0.0.1:${bound} to ${target.name}/${name}:127.0.0.1:${remote}\n`) });
            });
          await program.parseAsync(command, { from: "user" });
        } else {
          await negotiateHost(target, { signal });
          const terminal = Boolean(process.stdin.isTTY && process.stdout.isTTY);
          process.exitCode = await streamHost(target, createHostRequest("command", { args: selected.args, terminal }), { signal, terminal });
        }
      });
    }
  }
} catch (error) {
  if (error instanceof CommanderError) process.exitCode = error.code === "commander.helpDisplayed" ? 0 : error.exitCode || 2;
  else {
    if (!(error instanceof HostTransportError && error.reported)) console.error(error instanceof Error ? error.message : "DIM client failed");
    process.exitCode = signalExitCode ?? (error instanceof HostTransportError ? error.exitCode : error instanceof HostContextError || error instanceof CliHostProtocolError ? 2 : 1);
  }
}

function clientHostCommands(hosts: HostContextStore): Command {
  const program = new Command().name("dim").exitOverride();
  const host = program.command("host").description("Configure client-local Linux host connections");
  host.command("add").argument("<name>").requiredOption("--ssh <target>").action(async (name: string, flags: { ssh: string }) => {
    await hosts.add({ name, ssh: flags.ssh }); console.log(`Added host '${name}'; select it with 'dim host use ${name}'`);
  });
  host.command("list").alias("ls").option("--json").action(async (flags: { json?: boolean }) => {
    const targets = await hosts.list();
    if (flags.json) console.log(JSON.stringify(targets));
    else for (const target of targets) console.log(`${target.current ? "*" : " "} ${target.name}\t${target.ssh ?? "local"}`);
  });
  host.command("use").argument("<name>").action(async (name: string) => { await hosts.use(name); console.log(`Selected host '${name}'`); });
  host.command("remove").argument("<name>").action(async (name: string) => { await hosts.remove(name); console.log(`Removed host '${name}'`); });
  return program;
}
function hostArguments(args: string[]): { args: string[]; host?: string } {
  const remaining: string[] = []; let host: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--") { remaining.push(...args.slice(index)); break; }
    if (arg === "--host" || arg.startsWith("--host=")) {
      const value = arg === "--host" ? args[++index] : arg.slice(7);
      if (!value || value.startsWith("-")) throw new HostContextError("option '--host <name>' argument missing");
      host = value;
    } else remaining.push(arg);
  }
  return { args: remaining, ...(host === undefined ? {} : { host }) };
}
function port(value: string, zero = false): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < (zero ? 0 : 1) || number > 65535) throw new CliHostProtocolError("port must be between 1 and 65535 (local port 0 chooses an available port)");
  return number;
}
async function withSignals(action: (signal: AbortSignal) => Promise<void>): Promise<void> {
  const abort = new AbortController();
  const stop = (code: number) => { signalExitCode ??= code; abort.abort(); };
  const interrupt = () => stop(130), terminate = () => stop(143), hangup = () => stop(129);
  process.once("SIGINT", interrupt); process.once("SIGTERM", terminate); process.once("SIGHUP", hangup);
  try { await action(abort.signal); }
  finally {
    process.off("SIGINT", interrupt); process.off("SIGTERM", terminate); process.off("SIGHUP", hangup);
    if (signalExitCode !== undefined) process.exitCode = signalExitCode;
  }
}
