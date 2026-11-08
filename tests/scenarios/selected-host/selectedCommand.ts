import { CommandFailure, runCommand, type CommandResult } from "../web-lifecycle/process.js";
import { OperatorInputError, SmokeFailure, type HostProfile } from "./config.js";

type VmReadinessDiagnostic = "vm-startup-timeout" | "vm-agent-probe-failed" | "vm-docker-probe-failed" | "vm-guest-layout-invalid";
export type CommandEvidence = { readonly step: string; readonly surface: readonly string[]; readonly exitCode: number | null; readonly durationMilliseconds: number; readonly diagnostic?: VmReadinessDiagnostic };

/** Classify only VM-owned start failures; never publish arbitrary command output. */
function vmReadinessDiagnostic(args: readonly string[], stderr: string): VmReadinessDiagnostic | undefined {
  if (args[0] !== "vm" || args[1] !== "start") return;
  const message = stderr.trim().replace(/^dim(?:-host)?: /, "");
  if (/^VM startup deadline exceeded while waiting for (host admission|guest agent|guest Docker|guest readiness)(?:; last Incus readiness probe failed \(exit 1\): Error: local error: tls: bad record MAC)?$/.test(message)) return "vm-startup-timeout";
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

export function selectedCommandTracker(onCommand?: (evidence: CommandEvidence) => void) {
  const commands: CommandEvidence[] = [];
  return { commands, async checked(profile: HostProfile, step: string, args: readonly string[], timeoutMs = 120_000): Promise<CommandResult> {
    const started = performance.now(); let exitCode: number | null = null, diagnostic: VmReadinessDiagnostic | undefined;
    try {
      const result = await dim(profile.name, args, true, timeoutMs); exitCode = result.exitCode;
      if (result.exitCode !== 0) {
        diagnostic = vmReadinessDiagnostic(args, result.stderr);
        throw new SmokeFailure(profile.name, step, `command exited ${result.exitCode}${diagnostic ? ` (${diagnostic})` : ""}; inspect this selected host interactively`);
      }
      return result;
    } catch (error) {
      if (error instanceof SmokeFailure || error instanceof OperatorInputError) throw error;
      if (error instanceof CommandFailure) exitCode = error.result.exitCode;
      throw new SmokeFailure(profile.name, step, "selected-host transport, output bound or deadline failed; inspect private host diagnostics");
    } finally {
      const evidence = { step, surface: ["dim", "--host", profile.name, args[0] ?? "", ...(args[0] === "exec" ? ["<owned-workspace>", "--", args[3] ?? "<guest-command>"] : ["<scoped-arguments>"])], exitCode,
        durationMilliseconds: Math.ceil(performance.now() - started), ...(diagnostic === undefined ? {} : { diagnostic }) };
      commands.push(evidence); onCommand?.(evidence);
    }
  } };
}
