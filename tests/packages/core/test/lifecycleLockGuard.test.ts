import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { tryAcquireKernelGuard, type KernelGuard } from "../../../../packages/host/core/src/lifecycleLockGuard.js";

const roots: string[] = [], guards: KernelGuard[] = [];
afterEach(async () => {
  for (const guard of guards.splice(0).reverse()) await guard.release();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function path(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dim-kernel-guard-")); roots.push(root);
  return join(root, "owner.guard");
}
it("waits in the kernel for a held guard and acquires only after its owner releases", async () => {
  const file = await path();
  const owner = await tryAcquireKernelGuard(file);
  if (!owner) throw new Error("guard unavailable");
  guards.push(owner);
  let settled = false;
  const pending = tryAcquireKernelGuard(file, { timeoutMilliseconds: 2000 }).then((guard) => {
    settled = true; return guard;
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(settled).toBe(false);
  await owner.release(); guards.splice(guards.indexOf(owner), 1);
  const successor = await pending;
  expect(successor).toBeDefined();
  if (successor) guards.push(successor);
  expect(await tryAcquireKernelGuard(file)).toBeUndefined();
});
it("expires a bounded kernel wait without taking authority from a live owner", async () => {
  const file = await path();
  const owner = await tryAcquireKernelGuard(file);
  if (!owner) throw new Error("guard unavailable");
  guards.push(owner);
  expect(await tryAcquireKernelGuard(file, { timeoutMilliseconds: 50 })).toBeUndefined();
  expect(await tryAcquireKernelGuard(file)).toBeUndefined();
  for (const timeoutMilliseconds of [-1, 0.5, 30_001, Number.NaN]) {
    await expect(tryAcquireKernelGuard(file, { timeoutMilliseconds })).rejects.toThrow(/timeout/);
  }
});
