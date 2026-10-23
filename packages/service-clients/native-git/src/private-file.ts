import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
/** Private role connections stay on the caller's trusted side of the transport. */
export async function loadPrivateJson(path: string): Promise<unknown> {
  if (!isAbsolute(path)) throw new Error("Native Git connection path must be absolute");
  let handle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch { throw new Error("Native Git connection must be an owned mode-0600 regular file"); }
  try {
    const before = await handle.stat({ bigint: true }), uid = process.geteuid?.();
    if (uid === undefined || !before.isFile() || before.uid !== BigInt(uid) || before.nlink !== 1n || (before.mode & 0o777n) !== 0o600n || before.size < 1n || before.size > 1024n * 1024n) throw new Error("Native Git connection must be an owned mode-0600 regular file");
    const bytes = await handle.readFile(), after = await handle.stat({ bigint: true });
    if (bytes.length !== Number(before.size) || before.ino !== after.ino || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new Error("Native Git connection changed during read");
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch { throw new Error("Native Git private connection is invalid"); }
  finally { await handle.close(); }
}
