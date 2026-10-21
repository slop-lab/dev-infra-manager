import { spawn } from "node:child_process";
export interface CommandResult { readonly status: number; readonly stdout: string; readonly stderr: string }
export type Command = (file: string, args: readonly string[]) => Promise<CommandResult>;
export const createCommand = (env: NodeJS.ProcessEnv): Command => async (file, args) => new Promise((resolve, reject) => {
  const child = spawn(file, [...args], { stdio: ["ignore", "pipe", "pipe"], env });
  let stdout = "", stderr = "";
  const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error(`${file} operation timed out`)); }, 120_000);
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; if (stdout.length > 16 * 1024 * 1024) child.kill(); });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; if (stderr.length > 1024 * 1024) child.kill(); });
  child.once("error", (error) => { clearTimeout(timer); reject(error); });
  child.once("close", (status) => { clearTimeout(timer); resolve({ status: status ?? 1, stdout, stderr }); });
});
export const command = createCommand(process.env);
export async function checked(run: Command, file: string, args: readonly string[]): Promise<string> {
  const result = await run(file, args);
  if (result.status !== 0) throw new Error(`${file} ${args.slice(0, 2).join(" ")} failed: ${result.stderr.trim().slice(0, 1000)}`);
  return result.stdout;
}
