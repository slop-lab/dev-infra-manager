// @ts-check
import { chmod, chown, lchown, lstat, opendir } from "node:fs/promises";
import path from "node:path";
import { snapshotInputs } from "./qemu-snapshot.mjs";

/** @param {{handoffRoot:string, inputs:import("./qemu-types.js").Input[], snapshotRoot:string, signal:AbortSignal, uid:number, gid:number}} options */
export async function createInputHandoff({ handoffRoot, inputs, snapshotRoot, signal, uid, gid }) {
  const snapshots = await snapshotInputs({ inputs, inputsRoot: handoffRoot, sourceRoot: snapshotRoot, signal });
  await assignTree(handoffRoot, uid, gid, signal);
  return snapshots;
}

/** @param {string} directoryPath @param {number} uid @param {number} gid @param {AbortSignal} signal */
async function assignTree(directoryPath, uid, gid, signal) {
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
