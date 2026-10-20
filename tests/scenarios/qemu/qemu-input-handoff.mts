import { chmod, chown, lchown, lstat, opendir } from "node:fs/promises";
import path from "node:path";
import { snapshotInputs } from "./qemu-snapshot.mts";

export async function createInputHandoff({ handoffRoot, inputs, snapshotRoot, signal, uid, gid }: {handoffRoot:string, inputs:import("./qemu-types.js").Input[], snapshotRoot:string, signal:AbortSignal, uid:number, gid:number}) {
  const snapshots = await snapshotInputs({ inputs, inputsRoot: handoffRoot, sourceRoot: snapshotRoot, signal });
  await assignTree(handoffRoot, uid, gid, signal);
  return snapshots;
}

async function assignTree(directoryPath: string, uid: number, gid: number, signal: AbortSignal) {
  for await (const entry of await opendir(directoryPath)) {
    signal.throwIfAborted();
    const entryPath = path.join(directoryPath, entry.name);
    const metadata = await lstat(entryPath);
    if (metadata.isSymbolicLink()) {
      await lchown(entryPath, uid, gid);
    } else if (metadata.isDirectory()) {
      await assignTree(entryPath, uid, gid, signal);
    } else if (metadata.isFile()) {
      await chown(entryPath, uid, gid);
      await chmod(entryPath, 0o400 | (metadata.mode & 0o100));
    } else {
      throw new Error("QEMU input handoff contains an unsupported entry type");
    }
  }
  await chown(directoryPath, uid, gid);
  await chmod(directoryPath, 0o500);
}
