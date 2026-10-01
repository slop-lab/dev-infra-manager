import { spawn } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export type PluginManifest = {
  readonly schemaVersion: 1;
  readonly plugins: readonly string[];
};

export type RuntimePackage = {
  readonly dependencies?: Readonly<Record<string, string>>;
};

export async function readPackageJson(target: string): Promise<RuntimePackage | undefined> {
  try {
    return JSON.parse(await readFile(target, "utf8"));
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

export async function readManifest(target: string): Promise<PluginManifest> {
  try {
    const value: unknown = JSON.parse(await readFile(target, "utf8"));
    if (!isRecord(value) || value.schemaVersion !== 1 || !isStringArray(value.plugins)) {
      throw new Error(`invalid DIM plugin manifest at ${target}`);
    }
    return { schemaVersion: 1, plugins: value.plugins };
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { schemaVersion: 1, plugins: [] };
    throw error;
  }
}

export async function atomicWrite(target: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, target);
}

export async function run(command: string, args: readonly string[], cwd: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code ?? signal ?? "unknown status"}`));
    });
  });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
}
