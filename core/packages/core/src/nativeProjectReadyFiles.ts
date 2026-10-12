import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { NativeProjectPendingFileError } from "./nativeProjectPendingFiles.js";

export async function replaceNativeProjectRecord(
  path: string,
  expected: Buffer,
  replacement: Buffer
): Promise<void> {
  const current = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await current.readFile()).equals(expected)) {
      throw new NativeProjectPendingFileError("canonical Project record changed before ready publication");
    }
  } finally {
    await current.close();
  }
  const directory = dirname(path);
  const temporary = `${path}.${randomUUID()}.ready`;
  try {
    const staged = await open(temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try {
      await staged.writeFile(replacement);
      await staged.chmod(0o600);
      await staged.sync();
    } finally {
      await staged.close();
    }
    await rename(temporary, path);
    const parent = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
