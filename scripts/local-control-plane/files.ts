import { constants } from "node:fs";
import { mkdir, open, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { metadata } from "../local-uninstall/files.ts";

export async function privateDirectory(path: string): Promise<void> {
  const stat = await metadata(path);
  if (!stat) { await privateDirectory(dirname(path)); await mkdir(path, { mode: 0o700 }); return; }
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0) throw new Error(`unsafe local deployment directory: ${path}`);
}
export async function privateJson(path: string): Promise<unknown | undefined> {
  let handle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || stat.size > 1024 * 1024) throw new Error(`unsafe private deployment file: ${path}`);
    return JSON.parse(await handle.readFile("utf8")) as unknown;
  } finally { await handle.close(); }
}
export async function replaceJson(path: string, value: unknown): Promise<void> {
  const stage = `${path}.${randomUUID()}`;
  await writeFile(stage, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  await rename(stage, path);
}
