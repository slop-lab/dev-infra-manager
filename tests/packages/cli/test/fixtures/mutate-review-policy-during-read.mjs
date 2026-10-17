import filesystem from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { isAbsolute } from "node:path";

const policyPath = process.env.DIM_TEST_REVIEW_POLICY_PATH;
const marker = process.env.DIM_TEST_REVIEW_POLICY_MARKER;
if (!policyPath || !marker || !isAbsolute(policyPath) || !isAbsolute(marker)) {
  throw new Error("policy rewrite fixture requires explicit absolute paths");
}
const open = filesystem.open;
let rewritten = false;
filesystem.open = async function (path, ...arguments_) {
  const handle = await open(path, ...arguments_);
  if (path !== policyPath) return handle;
  const read = handle.read.bind(handle);
  handle.read = async function (...readArguments) {
    const result = await read(...readArguments);
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
  };
  return handle;
};
syncBuiltinESMExports();
