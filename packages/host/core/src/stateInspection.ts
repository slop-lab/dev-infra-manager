import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { UserError } from "./errors.js";

export async function inspectStateDirectory(target: string, label: string, missingAllowed: boolean): Promise<boolean> {
  try {
    const metadata = await lstat(target);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new UserError(`${label} at '${target}' must be a directory, not a symlink or special file`);
    }
    return true;
  } catch (error) {
    if (missingAllowed && errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

export async function readStateJsonFile(target: string, label: string): Promise<unknown> {
  const metadata = await lstat(target);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new UserError(`${label} at '${target}' must be a regular file, not a symlink or special file`);
  }
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== metadata.dev || opened.ino !== metadata.ino) {
      throw new UserError(`${label} at '${target}' changed while it was inspected`);
    }
    try {
      return JSON.parse(await handle.readFile("utf8"));
    } catch (error) {
      if (error instanceof SyntaxError) throw new UserError(`${label} at '${target}' is not valid JSON`);
      throw error;
    }
  } finally {
    await handle.close();
  }
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
}
