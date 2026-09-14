import { createInterface } from "node:readline/promises";
import { Command, type AddHelpTextContext } from "commander";
import {
  inspectWorkspaceBackends,
  ProcessRunner,
  UserError,
  type WorkspaceRuntimeBackendKind
} from "@slop-lab/dim-core";

export const runner = new ProcessRunner();

export interface RepoFlags {
  root?: boolean;
  ref?: string;
  protect?: string;
  json?: boolean;
}

export interface JsonFlags {
  json?: boolean;
}

export interface ResourceFlags {
  cpus?: string;
  memory?: string;
  pids?: string;
}

export interface WorkspaceCreateFlags extends JsonFlags {
  profile: string[];
  requireCapability: string[];
  recommendCapability: string[];
  repoRef: string[];
  kvm?: boolean;
  gitUserName?: string;
  gitUserEmail?: string;
  cpus?: string;
  memory?: string;
  pids?: string;
}

export interface DnsProviderAddFlags {
  name: string;
}

export interface IngressAddFlags {
  name: string;
  description: string;
  scheme: "http" | "https";
}

export interface ExternalUrlCreateFlags extends JsonFlags {
  ingress: string;
  subdomain?: string;
  container: string[];
  port: string;
  protocol: "http" | "https";
  path?: string;
  workspace?: string;
}

export interface WorkspaceControllerFlags extends JsonFlags {
  workspace?: string;
}

export function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export function commaSeparated(value: string): string[] {
  const values = value.split(",").map((item) => item.trim()).filter(Boolean);
  if (values.length === 0) throw new UserError("--protect must contain at least one pattern");
  return values;
}

export function installerFacadeHelpText(program: Command): (context: AddHelpTextContext) => string {
  return (context: AddHelpTextContext): string => {
  const rootText = `
Typical flow:
  dim project create PROJECT
  dim repo add PROJECT ROOT SOURCE_URL --root --ref main
  dim workspace create PROJECT WORKSPACE
  dim workspace exec WORKSPACE -- bash

Run 'dim help --all' to list administrative commands.`;

  if (process.env.DIM_INVOKED_VIA_INSTALLER !== "1") {
    return context.command === program ? rootText : "";
  }

  const installerVersion = process.env.DIM_INSTALLER_VERSION;
  const installerSuffix = installerVersion ? ` ${installerVersion}` : "";

  if (context.command !== program) {
    return `\nRunning via the DIM installer facade${installerSuffix}.`;
  }

  return `${rootText}

Running via the DIM installer facade${installerSuffix}. The following installer commands are also
available:
  dim installer        interactive installer UI
  dim install-cli      install or upgrade the DIM CLI
  dim install-plugin   install a DIM plugin`;
  };
}

export function interactive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

export async function confirmAction(yes: boolean, question: string): Promise<void> {
  if (yes) return;
  if (!interactive()) throw new UserError("confirmation requires --yes in a non-interactive shell");
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await prompt.question(`${question} [y/N] `)).trim().toLowerCase();
    if (answer !== "y" && answer !== "yes") throw new UserError("operation was not confirmed");
  } finally {
    prompt.close();
  }
}

export async function confirmRecommended(question: string): Promise<boolean> {
  if (!interactive()) throw new UserError("recommended confirmation requires an interactive shell");
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await prompt.question(`${question} [Y/n] `)).trim().toLowerCase();
    if (answer === "" || answer === "y" || answer === "yes") return true;
    if (answer === "n" || answer === "no") return false;
    throw new UserError("answer must be yes or no");
  } finally {
    prompt.close();
  }
}

export function parseWorkspaceBackend(value: string): WorkspaceRuntimeBackendKind {
  if (value === "sysbox") return value;
  throw new UserError("backend must be sysbox");
}

export async function selectInstalledWorkspaceBackend(): Promise<WorkspaceRuntimeBackendKind> {
  const [backend] = (await inspectWorkspaceBackends(runner))
    .filter((inspection) => inspection.ok)
    .map((inspection) => inspection.backend);
  if (backend === undefined) {
    throw new UserError("no installed workspace backend detected; install a host backend dependency first (sysbox, runc)");
  }
  return backend;
}

export function printDoctorChecks(checks: Array<{ name: string; ok: boolean; detail: string }>): void {
  for (const check of checks) {
    console.log(`${check.ok ? "ok" : "fail"}\t${check.name}\t${check.detail}`);
  }
}

export async function readStdin(): Promise<string> {
  let value = "";
  for await (const chunk of process.stdin) value += String(chunk);
  return value;
}

export function hasResourceFlags(flags: ResourceFlags): boolean {
  return flags.cpus !== undefined || flags.memory !== undefined || flags.pids !== undefined;
}

export function ciExecutor(value: string): "sysbox" | "qemu" {
  if (value !== "sysbox" && value !== "qemu") throw new UserError("CI executor must be 'sysbox' or 'qemu'");
  return value;
}

export function resourceInput(flags: ResourceFlags): { cpus?: string; memory?: string; pidsLimit?: string } {
  return {
    ...(flags.cpus === undefined ? {} : { cpus: flags.cpus }),
    ...(flags.memory === undefined ? {} : { memory: flags.memory }),
    ...(flags.pids === undefined ? {} : { pidsLimit: flags.pids })
  };
}

export function print(value: unknown, flags: JsonFlags = {}): void {
  if (flags.json || typeof value !== "object" || value === null || Array.isArray(value)) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue;
    console.log(`${key}: ${typeof item === "object" ? JSON.stringify(item) : String(item)}`);
  }
}

export function printActionResult(value: unknown, flags: JsonFlags, message: string): void {
  if (flags.json) print(value, flags);
  else console.log(message);
}

export function printList<T extends object>(records: T[], fields: string[], flags: JsonFlags = {}): void {
  if (flags.json) {
    print(records, flags);
    return;
  }
  if (records.length === 0) return;
  console.table(records.map((record) => {
    const values = record as Record<string, unknown>;
    return Object.fromEntries(fields.map((field) => [field, values[field] ?? ""]));
  }));
}

export function cliPort(value: string, flag: string, zero: boolean): number {
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < (zero ? 0 : 1) || port > 65_535) {
    throw new UserError(`${flag} must be between ${zero ? 0 : 1} and 65535`);
  }
  return port;
}
