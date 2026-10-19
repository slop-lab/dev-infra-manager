import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
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
  const temporary = `${target}.tmp-${randomUUID()}`;
  const file = await open(temporary, "wx", 0o600);
  try {
    try { await file.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8"); }
    finally { await file.close(); }
    await rename(temporary, target);
  } finally { await rm(temporary, { force: true }); }
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
