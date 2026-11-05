import { spawn } from "node:child_process";
import { terminateCommandTree } from "./command-process.ts";
export interface CommandResult { readonly status: number; readonly stdout: string; readonly stderr: string }
export type Command = (file: string, args: readonly string[]) => Promise<CommandResult>;
export interface CommandOptions {
  readonly timeoutMilliseconds?: number;
  readonly terminationGraceMilliseconds?: number;
  readonly signal?: AbortSignal;
}
export function createCommand(env: NodeJS.ProcessEnv, options: CommandOptions = {}): Command {
  const timeout = options.timeoutMilliseconds ?? 120_000, grace = options.terminationGraceMilliseconds ?? 1_000;
  if (![timeout, grace].every((value) => Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647)) throw new Error("invalid command time budget");
  return async (file, args) => new Promise((resolve, reject) => {
    if (options.signal?.aborted) { reject(new Error(`${file} operation cancelled`)); return; }
    const child = spawn(file, [...args], { detached: true, stdio: ["ignore", "pipe", "pipe"], env });
    let stdout = "", stderr = "", stopping = false, settled = false;
    const finish = (result: CommandResult | Error): void => {
      if (settled) return;
      settled = true; clearTimeout(timer); options.signal?.removeEventListener("abort", abort);
      process.off("SIGINT", abort); process.off("SIGTERM", abort);
      if (result instanceof Error) reject(result); else resolve(result);
    };
    const stop = (reason: string): void => {
      if (stopping || settled) return;
      stopping = true; clearTimeout(timer);
      void terminateCommandTree(child.pid, grace).then(
        () => finish(new Error(`${file} operation ${reason}`)),
        (error: unknown) => finish(new Error(`${file} operation ${reason}; descendant cleanup unconfirmed`, { cause: error }))
      ).finally(() => { child.stdout.destroy(); child.stderr.destroy(); });
    };
    const abort = (): void => stop("cancelled");
    const timer = setTimeout(() => stop("timed out"), timeout);
    process.on("SIGINT", abort); process.on("SIGTERM", abort);
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    const append = (value: string, chunk: string, maximum: number): string => {
      if (stopping) return value;
      if (value.length + chunk.length > maximum) { stop("exceeded output limit"); return value; }
      return value + chunk;
    };
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout = append(stdout, chunk, 16 * 1024 * 1024); });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr = append(stderr, chunk, 1024 * 1024); });
    child.once("error", (error) => { if (!stopping) finish(error); });
    child.once("close", (status) => { if (!stopping) finish({ status: status ?? 1, stdout, stderr }); });
  });
}
/** Package installation needs a longer bounded budget; ordinary commands retain two minutes. */
export const createInstallCommand = (env: NodeJS.ProcessEnv): Command => createCommand(
  { ...env, npm_config_prefer_offline: env.npm_config_prefer_offline ?? env.NPM_CONFIG_PREFER_OFFLINE ?? "true" },
  { timeoutMilliseconds: 600_000 }
);
export const command = createCommand(process.env);
export const installCommand = createInstallCommand(process.env);
export async function checked(run: Command, file: string, args: readonly string[]): Promise<string> {
  const result = await run(file, args);
  if (result.status !== 0) throw new Error(`${file} ${args.slice(0, 2).join(" ")} failed: ${result.stderr.trim().slice(0, 1000)}`);
  return result.stdout;
}
