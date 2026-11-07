import { expect, it, vi } from "vitest";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
const fault = vi.hoisted(() => ({ replaceBeforeCopy: "" }));
vi.mock("node:fs/promises", async original => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, cp: async (...args: Parameters<typeof actual.cp>) => {
    if (args[0] === fault.replaceBeforeCopy) await actual.writeFile(fault.replaceBeforeCopy, "late replacement");
    await actual.cp(...args);
  } };
});
import { copyPinnedUbuntuImage } from "../../../../packages/host/plugins/execution-worker/src/nativeQemuRunnerImage.js";
it("rejects cache replacement between selection and copy because Docker's private bytes are hashed", async () => {
  const root = await mkdtemp(join(tmpdir(), "dim-image-pin-"));
  try {
    const source = join(root, "cache"), destination = join(root, "private.qcow2"), bytes = "reviewed public image";
    await writeFile(source, bytes); fault.replaceBeforeCopy = source;
    await expect(copyPinnedUbuntuImage(source, destination, createHash("sha256").update(bytes).digest("hex"))).rejects.toThrow("checksum mismatch");
    expect(await readFile(destination, "utf8")).toBe("late replacement");
  } finally { fault.replaceBeforeCopy = ""; await rm(root, { recursive: true, force: true }); }
});
