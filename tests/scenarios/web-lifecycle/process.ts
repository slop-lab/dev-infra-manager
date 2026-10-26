import { spawn } from "node:child_process";

export type CommandResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

export type CommandOptions = {
  readonly acceptFailure?: boolean;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly maxOutputBytes?: number;
  readonly timeoutMs?: number;
};

export class CommandFailure extends Error {
  readonly name = "CommandFailure";
  constructor(
    readonly file: string,
    readonly arguments_: readonly string[],
    readonly result: CommandResult
  ) {
    super(`command failed (${result.exitCode})`);
  }
}

export async function runCommand(file: string, arguments_: readonly string[], options: CommandOptions = {}): Promise<CommandResult> {
  const signal = AbortSignal.timeout(options.timeoutMs ?? 120_000);
  const child = spawn(file, arguments_, {
    cwd: options.cwd,
    env: options.env,
    signal,
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  let outputBytes = 0;
  const maxOutputBytes = options.maxOutputBytes ?? 2 * 1024 * 1024;
  const append = (stream: "stdout" | "stderr", chunk: string) => {
    outputBytes += Buffer.byteLength(chunk);
    if (outputBytes > maxOutputBytes) {
      child.kill("SIGKILL");
      return;
    }
    if (stream === "stdout") stdout += chunk;
    else stderr += chunk;
  };
  child.stdout.on("data", (chunk: string) => { append("stdout", chunk); });
  child.stderr.on("data", (chunk: string) => { append("stderr", chunk); });
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, terminatedBy) => {
      if (terminatedBy !== null && outputBytes <= maxOutputBytes) reject(new CommandFailure(file, arguments_, { exitCode: 1, stdout, stderr: `terminated by ${terminatedBy}` }));
      else resolve(code ?? 1);
    });
  });
  if (outputBytes > maxOutputBytes) throw new CommandFailure(file, arguments_, { exitCode: 1, stdout: "", stderr: "output limit exceeded" });
  const result = { exitCode, stdout, stderr };
  if (exitCode !== 0 && options.acceptFailure !== true) throw new CommandFailure(file, arguments_, result);
  return result;
}
