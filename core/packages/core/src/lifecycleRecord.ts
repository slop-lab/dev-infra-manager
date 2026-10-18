import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { MissingRecordError, UserError } from "./errors.js";

export function validateLifecycleName(value: string, kind: string): string {
  if (!/^[a-z0-9][a-z0-9_.-]{0,47}$/.test(value)) {
    throw new UserError(`${kind} name must match [a-z0-9][a-z0-9_.-]{0,47}`);
  }
  return value;
}

export async function atomicWrite(target: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, target);
}

export async function readJson<T>(target: string, missingMessage: string): Promise<T> {
  try {
    return JSON.parse(await readFile(target, "utf8")) as T;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new MissingRecordError(missingMessage);
    }
    throw error;
  }
}
