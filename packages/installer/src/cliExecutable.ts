import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import path from "node:path";
import type { DimCliConfig } from "./installConfig.js";

export async function validateConfiguredCli(cli: DimCliConfig, facadePath: string | undefined): Promise<string> {
  const executable = path.resolve(cli.executable);
  try { await access(executable, constants.X_OK); }
  catch { throw new Error(`DIM CLI ${cli.version} is configured at ${executable}, but it is not executable; run 'dim installer install cli'`); }
  if (facadePath !== undefined) {
    try {
      if (await realpath(executable) === await realpath(facadePath)) {
        throw new Error("DIM CLI configuration points back to the installer facade");
      }
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
  }
  return executable;
}

export async function queryCliVersion(executable: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (output.length > 16 * 1024) child.kill();
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0
      ? resolve(output.trim())
      : reject(new Error(`${executable} --version exited with ${code ?? signal ?? "unknown status"}`)));
  });
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
}
