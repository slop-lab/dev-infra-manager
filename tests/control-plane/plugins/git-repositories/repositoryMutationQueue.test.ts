import { expect, it } from "vitest";
import { createRepositoryMutationQueue } from "../../../../packages/control-plane/plugins/git-repositories/src/repository-mutation-queue.js";

const first = { projectId: "project", repositoryId: "first" };
const second = { projectId: "project", repositoryId: "second" };

it("allows another repository to finish while preserving one repository's mutation order", async () => {
  // Given a mutation that deliberately holds its repository lane.
  const queue = createRepositoryMutationQueue();
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const events: string[] = [];
  const held = queue.mutate(first, async () => { entered.resolve(); await release.promise; events.push("first"); });
  await entered.promise;
  const next = queue.mutate(first, async () => { events.push("next"); });
  // When an independent repository mutates.
  try {
    await queue.mutate(second, async () => { events.push("independent"); });
    // Then it completes without releasing the first lane.
    expect(events).toEqual(["independent"]);
  } finally { release.resolve(); await Promise.all([held, next]); await queue.close(); }
  expect(events).toEqual(["independent", "first", "next"]);
});

it("orders an exclusive lifecycle fence between earlier and later repository mutations", async () => {
  // Given an earlier repository mutation and an exclusive fence queued behind it.
  const queue = createRepositoryMutationQueue(), release = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>(), fenceEntered = Promise.withResolvers<void>();
  const releaseFence = Promise.withResolvers<void>(), events: string[] = [];
  const earlier = queue.mutate(first, async () => { entered.resolve(); await release.promise; events.push("earlier"); });
  await entered.promise;
  const fence = queue.exclusive(async () => { events.push("fence"); fenceEntered.resolve(); await releaseFence.promise; });
  const later = queue.mutate(second, async () => { events.push("later"); });
  // When the earlier mutation releases the fence.
  release.resolve(); await fenceEntered.promise;
  try { expect(events).toEqual(["earlier", "fence"]); }
  finally { releaseFence.resolve(); await Promise.all([earlier, fence, later]); await queue.close(); }
  // Then even another repository waits for the lifecycle fence.
  expect(events).toEqual(["earlier", "fence", "later"]);
});

it("drains accepted work on close and does not poison a lane after failure", async () => {
  // Given a failed mutation followed by accepted work.
  const queue = createRepositoryMutationQueue();
  await expect(queue.mutate(first, async () => { throw new Error("fixture failure"); })).rejects.toThrow("fixture failure");
  const release = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
  const accepted = queue.mutate(first, async () => { entered.resolve(); await release.promise; return "completed"; });
  await entered.promise;
  // When admission closes.
  const drained = queue.close();
  await expect(queue.mutate(second, async () => "late")).rejects.toThrow("closed");
  await expect(queue.exclusive(async () => "late")).rejects.toThrow("closed");
  release.resolve();
  // Then the accepted operation finishes normally before the drain resolves.
  expect(await accepted).toBe("completed"); await drained;
});
