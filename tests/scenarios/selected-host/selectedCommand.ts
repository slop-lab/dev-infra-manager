import { CommandFailure, runCommand, type CommandResult } from "../web-lifecycle/process.js";
import { OperatorInputError, SmokeFailure, type HostProfile } from "./config.js";

export type CommandEvidence = { readonly step: string; readonly surface: readonly string[]; readonly exitCode: number | null; readonly durationMilliseconds: number };

export function dim(host: string, args: readonly string[], acceptFailure: boolean, timeoutMs = 120_000): Promise<CommandResult> {
  return runCommand("dim", ["--host", host, ...args], { acceptFailure, timeoutMs }).catch((error: unknown) => {
    if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") throw new OperatorInputError("DIM client executable is unavailable; provide the reviewed installed CLI before selected-host verification");
    throw error;
  });
}

export function selectedCommandTracker(onCommand?: (evidence: CommandEvidence) => void) {
  const commands: CommandEvidence[] = [];
  return { commands, async checked(profile: HostProfile, step: string, args: readonly string[], timeoutMs = 120_000): Promise<CommandResult> {
    const started = performance.now(); let exitCode: number | null = null;
    try {
      const result = await dim(profile.name, args, true, timeoutMs); exitCode = result.exitCode;
      if (result.exitCode !== 0) throw new SmokeFailure(profile.name, step, `command exited ${result.exitCode}; inspect this selected host interactively`);
      return result;
    } catch (error) {
      if (error instanceof SmokeFailure || error instanceof OperatorInputError) throw error;
      if (error instanceof CommandFailure) exitCode = error.result.exitCode;
      throw new SmokeFailure(profile.name, step, "selected-host transport, output bound or deadline failed; inspect private host diagnostics");
    } finally {
      const evidence = { step, surface: ["dim", "--host", profile.name, args[0] ?? "", ...(args[0] === "exec" ? ["<owned-workspace>", "--", args[3] ?? "<guest-command>"] : ["<scoped-arguments>"])], exitCode,
        durationMilliseconds: Math.ceil(performance.now() - started) };
      commands.push(evidence); onCommand?.(evidence);
    }
  } };
}
