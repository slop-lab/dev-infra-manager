import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export function processIsLive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && error.message.includes("ESRCH")) return false;
    throw error;
  }
}

export async function ownerPid(serviceDirectory: string): Promise<number> {
  const value: unknown = JSON.parse(await readFile(resolve(serviceDirectory, "service-owner.json"), "utf8"));
  if (typeof value !== "object" || value === null || !("pid" in value) || typeof value.pid !== "string") {
    throw new TypeError("structured owner PID is missing");
  }
  return Number.parseInt(value.pid, 10);
}
