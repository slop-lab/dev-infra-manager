import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { WorkspaceStore } from "../../../packages/host/core/src/workspace/store.js";

test("cancelling a queued lifecycle mutation preserves the active owner and permits a later mutation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dim-lock-cancel-"));
  let releaseOwner!: () => void;
  let ownerReady!: () => void;
  const ready = new Promise<void>((resolve) => { ownerReady = resolve; });
  const held = new WorkspaceStore(root).withLock("dev", async () => {
    ownerReady();
    await new Promise<void>((resolve) => { releaseOwner = resolve; });
  });
  try {
    await ready;
    const ownerPath = path.join(root, "locks/workspace-dev.lock");
    const original = await readFile(ownerPath, "utf8");
    const abort = new AbortController();
    let mutated = false;
    const waiting = new WorkspaceStore(root, { signal: abort.signal }).withLock("dev", async () => { mutated = true; });
    setTimeout(() => abort.abort(), 150);
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    expect(mutated).toBe(false);
    expect(await readFile(ownerPath, "utf8")).toBe(original);
    releaseOwner();
    await held;
    await new WorkspaceStore(root).withLock("dev", async () => { mutated = true; });
    expect(mutated).toBe(true);
  } finally {
    releaseOwner?.();
    await held;
    await rm(root, { recursive: true, force: true });
  }
});
