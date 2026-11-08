import { constants, closeSync, fstatSync, fsyncSync, lstatSync, openSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { CommandFailure, runCommand, type CommandResult } from "../web-lifecycle/process.js";
import { OperatorInputError, SmokeFailure, type HostProfile } from "./config.js";

type VmReadinessDiagnostic = "vm-startup-timeout" | "vm-agent-probe-failed" | "vm-docker-probe-failed" | "vm-guest-layout-invalid";
export type CommandEvidence = { readonly step: string; readonly surface: readonly string[]; readonly exitCode: number | null; readonly durationMilliseconds: number; readonly diagnostic?: VmReadinessDiagnostic; readonly failureReceiptUnavailable?: true; readonly failureReceipt?: { readonly path: string; readonly record: number; readonly sha256: string } };

export type FixtureCommandTarget = { readonly kind: "opencode-setup" | "auxiliary-readiness"; readonly name: string; readonly id: string };
export type FixtureFailureWriter = (target: FixtureCommandTarget, result: CommandResult) => { readonly path: string; readonly record: number; readonly sha256: string };

/** Only the generated CI fixture enables this separate private stderr receipt.
 * Record hashes bind original private bytes; the existing artifact exporter may redact them. */
export function fixtureFailureWriter(file: string): FixtureFailureWriter {
  const parent = lstatSync(path.dirname(file));
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid?.() || (parent.mode & 0o022) !== 0) throw new Error("unsafe fixture diagnostic directory");
  const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  const identity = fstatSync(fd); closeSync(fd);
  let records = 0;
  return (target, result) => {
    if (++records > 4) throw new Error("fixture diagnostic count exceeded");
    const stderr = Buffer.from(result.stderr);
    let offset = Math.max(0, stderr.length - 16 * 1024);
    while (offset < stderr.length && (stderr[offset]! & 0xc0) === 0x80) offset++;
    const tail = stderr.subarray(offset);
    const bytes = Buffer.from(JSON.stringify({ kind: target.kind, owned: { name: target.name, id: target.id }, exitCode: result.exitCode,
      stderrBytes: stderr.length, truncated: stderr.length > tail.length, stderr: tail.toString("utf8") }) + "\n");
    const current = openSync(file, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(current);
      if (!stat.isFile() || stat.dev !== identity.dev || stat.ino !== identity.ino || stat.uid !== process.getuid?.() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || stat.size > 4 * 100_000) throw new Error("fixture diagnostic ownership changed");
      writeFileSync(current, bytes); fsyncSync(current);
    } finally { closeSync(current); }
    return { path: path.basename(file), record: records, sha256: createHash("sha256").update(bytes).digest("hex") };
  };
}
function assertFixtureTarget(profile: HostProfile, step: string, args: readonly string[], target: FixtureCommandTarget): void {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  if (!uuid.test(target.id) || !/^dim-smoke-[a-z0-9-]+$/.test(target.name)) throw new Error("invalid fixture diagnostic identity");
  const expected = target.kind === "opencode-setup" ? ["tools", "setup", target.name, "opencode"] : ["vm", "start", target.name, "--expect-id", target.id];
  if (step !== (target.kind === "opencode-setup" ? "owned workspace OpenCode setup" : "auxiliary VM readiness") || args.length !== expected.length || !args.every((value, index) => value === expected[index]) || target.kind === "opencode-setup" && target.name !== profile.workspace) throw new Error("fixture diagnostic operation mismatch");
}

/** Classify only VM-owned start failures; never publish arbitrary command output. */
function vmReadinessDiagnostic(args: readonly string[], stderr: string): VmReadinessDiagnostic | undefined {
  if (args[0] !== "vm" || args[1] !== "start") return;
  const message = stderr.trim().replace(/^dim(?:-host)?: /, "");
  if (/^VM startup deadline exceeded while waiting for (host admission|guest agent|guest Docker|guest readiness)(?:; last Incus readiness probe failed \(exit (?:1|255)\): Error: local error: tls: bad record MAC|; last Incus readiness probe failed \(exit 1\): Error: Get "http:\/\/unix\.socket\/1\.0\/operations\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\?project=[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}": EOF)?$/.test(message)) return "vm-startup-timeout";
  if (/^VM guest readiness failed: [^\r\n]+$/.test(message)) return "vm-agent-probe-failed";
  if (/^VM guest Docker readiness failed: [^\r\n]+$/.test(message)) return "vm-docker-probe-failed";
  if (message === "auxiliary VM image must provide writable /workspace and private mode-0700 /mnt/dim-tmp for user dim") return "vm-guest-layout-invalid";
}

export function dim(host: string, args: readonly string[], acceptFailure: boolean, timeoutMs = 120_000): Promise<CommandResult> {
  return runCommand(process.env.DIM_BIN ?? "dim", ["--host", host, ...args], { acceptFailure, timeoutMs }).catch((error: unknown) => {
    if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") throw new OperatorInputError("DIM client executable is unavailable; provide the reviewed installed CLI before selected-host verification");
    throw error;
  });
}

export function selectedCommandTracker(onCommand?: (evidence: CommandEvidence) => void, writeFailure?: FixtureFailureWriter, onStart?: (step: string) => void) {
  const commands: CommandEvidence[] = [];
  return { commands, async checked(profile: HostProfile, step: string, args: readonly string[], timeoutMs = 120_000, target?: FixtureCommandTarget): Promise<CommandResult> {
    if (target !== undefined) assertFixtureTarget(profile, step, args, target);
    let failureReceipt: CommandEvidence["failureReceipt"], failureReceiptUnavailable = false;
    const started = performance.now(); let exitCode: number | null = null, diagnostic: VmReadinessDiagnostic | undefined;
    onStart?.(step);
    try {
      const result = await dim(profile.name, args, true, timeoutMs); exitCode = result.exitCode;
      if (result.exitCode !== 0) {
        diagnostic = vmReadinessDiagnostic(args, result.stderr);
        if (target !== undefined && writeFailure !== undefined) {
          try { failureReceipt = writeFailure(target, result); }
          catch { failureReceiptUnavailable = true; }
        }
        throw new SmokeFailure(profile.name, step, `command exited ${result.exitCode}${diagnostic ? ` (${diagnostic})` : ""}${failureReceiptUnavailable ? "; private diagnostic capture unavailable" : ""}; inspect this selected host interactively`);
      }
      return result;
    } catch (error) {
      if (error instanceof SmokeFailure || error instanceof OperatorInputError) throw error;
      if (error instanceof CommandFailure) exitCode = error.result.exitCode;
      throw new SmokeFailure(profile.name, step, "selected-host transport, output bound or deadline failed; inspect private host diagnostics");
    } finally {
      const evidence = { step, surface: ["dim", "--host", profile.name, args[0] ?? "", ...(args[0] === "exec" ? ["<owned-workspace>", "--", args[3] ?? "<guest-command>"] : ["<scoped-arguments>"])], exitCode,
        durationMilliseconds: Math.ceil(performance.now() - started), ...(diagnostic === undefined ? {} : { diagnostic }), ...(failureReceipt === undefined ? {} : { failureReceipt }), ...(failureReceiptUnavailable ? { failureReceiptUnavailable: true as const } : {}) };
      commands.push(evidence); onCommand?.(evidence);
    }
  } };
}
