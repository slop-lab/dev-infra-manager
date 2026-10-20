import filesystem from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { isAbsolute } from "node:path";

const policyPathInput = process.env.DIM_TEST_REVIEW_POLICY_PATH;
const markerInput = process.env.DIM_TEST_REVIEW_POLICY_MARKER;
if (!policyPathInput || !markerInput || !isAbsolute(policyPathInput) || !isAbsolute(markerInput)) {
  throw new Error("policy rewrite fixture requires explicit absolute paths");
}
const policyPath = policyPathInput;
const marker = markerInput;
const open = filesystem.open;
let rewritten = false;
filesystem.open = async function (path, ...arguments_) {
  const handle = await open(path, ...arguments_);
  if (path !== policyPath) return handle;
  handle.read = new Proxy(handle.read, {
    apply(target, _receiver, arguments_) {
      return readAndMutate(target, handle, arguments_);
    }
  });
  return handle;
};
syncBuiltinESMExports();

async function readAndMutate(read: import("node:fs/promises").FileHandle["read"], handle: import("node:fs/promises").FileHandle, readArguments: unknown[]): Promise<unknown> {

  const result: unknown = await Reflect.apply(read, handle, readArguments);
  if (typeof result !== "object" || result === null || !("bytesRead" in result) || typeof result.bytesRead !== "number") {
    throw new Error("FileHandle.read returned an invalid result");
  }
  if (!rewritten && result.bytesRead > 0) {
    rewritten = true;
    const writer = await open(policyPath, "r+");
    try {
      const before = await writer.stat({ bigint: true });
      await writer.write("\t", Number(before.size) - 1, "utf8");
      // Change real metadata deterministically, without clock resolution or
      // scheduler assumptions. Keep both the inode and file length intact.
      const changedTime = new Date(Number(before.mtimeNs / 1_000_000n) + 2_000);
      await writer.utimes(changedTime, changedTime);
    } finally { await writer.close(); }
    await filesystem.writeFile(marker, "rewritten-during-read\n", { flag: "wx", mode: 0o600 });
  }
  return result;
}
