import { spawn } from "node:child_process";
import { access, mkdir, readFile, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { makeTempDir } from "./support.js";

/** Exercise the installer dispatcher as a real subprocess using the required
 * centralized test dependency. Missing tooling is a setup failure, never a skip. */
export const cliEntry = fileURLToPath(new URL("../../packages/installer/src/cli.ts", import.meta.url));
export const tsxPath = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));
const tsxLoader = fileURLToPath(new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url));
await access(tsxPath, constants.X_OK);

const temporaryDirectories: string[] = [];

export async function cleanupCliTempDirs(): Promise<void> {
  await Promise.all(temporaryDirectories.splice(0).map((target) => rm(target, { recursive: true, force: true })));
}

export async function tempDir(prefix: string): Promise<string> {
  const dir = await makeTempDir(prefix);
  temporaryDirectories.push(dir);
  return dir;
}

export async function baseEnv(root: string): Promise<{
  env: NodeJS.ProcessEnv;
  configPath: string;
  dataHome: string;
}> {
  const home = join(root, "home");
  const configPath = join(root, "config", "dim.json");
  const dataHome = join(root, "data-home");
  await mkdir(home, { recursive: true });
  return {
    env: {
      PATH: process.env.PATH ?? "",
      HOME: home,
      DIM_CONFIG_PATH: configPath,
      DIM_DATA_HOME: dataHome
    },
    configPath,
    dataHome
  };
}

export async function npmArguments(file: string): Promise<string[]> {
  try {
    const history: string[][] = JSON.parse(await readFile(`${file}.calls`, "utf8"));
    return history.findLast(args => args.some(value => /\/runtime\/\.staging-/.test(value) && !value.includes("/cli/runtime/"))) ?? history.at(-1) ?? [];
  } catch { return JSON.parse(await readFile(file, "utf8")); }
}

interface CliResult {
  stdout: string;
  stderr: string;
  code: number | null;
  pid: number | undefined;
}

export function runCli(args: string[], executable: string, env: NodeJS.ProcessEnv, cwd: string): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [cliEntry, ...args], {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ stdout, stderr, code, pid: child.pid }));
    child.stdin.end();
  });
}

export function runCliDirect(args: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--conditions=dim-source", "--import", tsxLoader, cliEntry, ...args], {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("close", (code) => resolve({ stdout, stderr, code, pid: child.pid }));
    child.stdin.end();
  });
}

export function runCliInPty(
  args: readonly string[],
  input: string,
  executable: string,
  env: NodeJS.ProcessEnv,
  cwd: string
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const command = [executable, cliEntry, ...args].map((value) => `'${value.replaceAll("'", "'\\''")}'`).join(" ");
    const child = spawn("script", ["--quiet", "--return", "--command", command, "/dev/null"], {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("close", (code) => resolve({ stdout, stderr, code, pid: child.pid }));
    child.stdin.end(input);
  });
}

export const sourceRepositoryUrl = "https://github.com/slop-lab/dev-infra-manager";
