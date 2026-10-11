import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LifecycleState } from "../../../../core/packages/core/src/lifecycleState.js";
import { startLockChild, type LockChild } from "./lifecycleLockHarness.js";

const ownerReadFailures = vi.hoisted(() => ({
  attempts: new Map<string, number>(),
  failures: new Map<string, "EACCES" | "EPERM">()
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: vi.fn(async (target: Parameters<typeof actual.readFile>[0], encoding: BufferEncoding) => {
      const targetPath = String(target);
      const code = ownerReadFailures.failures.get(targetPath);
      if (code !== undefined) {
        ownerReadFailures.attempts.set(targetPath, (ownerReadFailures.attempts.get(targetPath) ?? 0) + 1);
        throw Object.assign(new Error(`injected ${code} owner read failure`), { code });
      }
      return actual.readFile(target, encoding);
    })
  };
});

function advancingClock(start: number): {
  readonly now: () => number;
  readonly sleep: (milliseconds: number) => Promise<void>;
} {
  let current = start;
  return {
    now: () => current,
    sleep: async (milliseconds) => { current += milliseconds; }
  };
}

describe("lifecycle lock ownership", () => {
  let root: string;
  let children: LockChild[];

  beforeEach(async () => {
    ownerReadFailures.attempts.clear();
    ownerReadFailures.failures.clear();
    root = await mkdtemp(join(tmpdir(), "dim-lifecycle-lock-"));
    children = [];
  });

  afterEach(async () => {
    const terminations = await Promise.allSettled(children.map((child) => child.kill()));
    await rm(root, { recursive: true, force: true });
    const failures: unknown[] = [];
    for (const termination of terminations) {
      if (termination.status === "rejected") failures.push(termination.reason);
    }
    if (failures.length > 0) throw new AggregateError(failures, "lock child cleanup failed");
  });

  const startChild = (name: string): LockChild => {
    const child = startLockChild(root, name);
    children.push(child);
    return child;
  };

  it("keeps a live process owner exclusive after the former stale threshold", async () => {
    // Given: one process owns the workspace lock for longer than five minutes.
    const clock = advancingClock(0);
    const state = new LifecycleState(root, { ...clock, waitTimeoutMs: 20, retryDelayMs: 5 });
    const releaseFirst = await state.acquireWorkspaceLock("work-1");

    // When: an independent acquisition contends for the same lock.
    let secondAcquired = false;
    const second = state.acquireWorkspaceLock("work-1").then((release) => {
      secondAcquired = true;
      return release;
    });
    const observation = await second.then(() => "acquired" as const).catch(() => "blocked" as const);

    // Then: elapsed age alone never lets the contender overlap the live owner.
    expect({ observation, secondAcquired }).toEqual({ observation: "blocked", secondAcquired: false });
    await releaseFirst();
  });

  it("publishes a complete versioned process-instance owner record atomically", async () => {
    // Given: no owner exists for a workspace lock.
    const state = new LifecycleState(root);

    // When: this process acquires the lock.
    const release = await state.acquireWorkspaceLock("work-1");

    // Then: the owner record contains every process-instance and release identity field.
    const ownerPath = join(root, "locks", "workspace-work-1.lock");
    const owner = JSON.parse(await readFile(ownerPath, "utf8"));
    expect(owner).toEqual({
      version: 1,
      pid: process.pid,
      bootId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      processStartTicks: expect.stringMatching(/^\d+$/),
      acquiredAt: expect.stringMatching(/^1970-|^20\d\d-/),
      nonce: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/)
    });
    expect((await stat(ownerPath)).mode & 0o777).toBe(0o600);
    expect((await stat(join(root, "locks"))).mode & 0o777).toBe(0o700);
    await release();
  });

  it("reclaims a lock after its child owner dies", async () => {
    // Given: a child process acquires a lock and then dies without releasing it.
    const child = startChild("work-1");
    await child.ready();
    await child.start();
    await child.acquired();
    await child.kill();

    // When: this process acquires the abandoned lock.
    const release = await new LifecycleState(root, { waitTimeoutMs: 2_000 }).acquireWorkspaceLock("work-1");

    // Then: the dead child's owner record has been reclaimed.
    const owner = JSON.parse(await readFile(join(root, "locks", "workspace-work-1.lock"), "utf8"));
    expect(owner.pid).toBe(process.pid);
    await release();
  });

  it("reclaims an owner when the PID belongs to a different process instance", async () => {
    // Given: a valid owner record names a PID whose start identity is reported as reused.
    const original = new LifecycleState(root);
    const releaseOriginal = await original.acquireWorkspaceLock("work-1");
    const ownerPath = join(root, "locks", "workspace-work-1.lock");
    const oldOwner = await readFile(ownerPath, "utf8");
    await releaseOriginal();
    await writeFile(ownerPath, oldOwner);
    const state = new LifecycleState(root, {
      probeProcess: async () => "reused",
      waitTimeoutMs: 100
    });

    // When: a new nonce acquires the reused-PID owner's lock.
    const release = await state.acquireWorkspaceLock("work-1");

    // Then: the record is replaced rather than blocked by PID existence alone.
    expect(await readFile(ownerPath, "utf8")).not.toBe(oldOwner);
    await release();
  });

  it("does not let an old release closure remove a successor owner", async () => {
    // Given: the first acquisition has released and a successor owns the same lock.
    const state = new LifecycleState(root);
    const releaseFirst = await state.acquireWorkspaceLock("work-1");
    await releaseFirst();
    const releaseSecond = await state.acquireWorkspaceLock("work-1");
    const ownerPath = join(root, "locks", "workspace-work-1.lock");
    const successor = await readFile(ownerPath, "utf8");

    // When: the old release closure is invoked again.
    await releaseFirst();

    // Then: only the successor nonce remains authoritative.
    expect(await readFile(ownerPath, "utf8")).toBe(successor);
    await releaseSecond();
  });

  it("refuses to release an owner record published with another nonce", async () => {
    // Given: the owner path no longer contains the acquiring nonce.
    const state = new LifecycleState(root);
    const release = await state.acquireWorkspaceLock("work-1");
    const ownerPath = join(root, "locks", "workspace-work-1.lock");
    const owner = JSON.parse(await readFile(ownerPath, "utf8"));
    const successor = { ...owner, nonce: "A".repeat(43) };
    await writeFile(ownerPath, `${JSON.stringify(successor)}\n`);

    // When: the displaced owner invokes its release closure.
    const staleRelease = release();

    // Then: release fails visibly without unlinking the successor record.
    await expect(staleRelease).rejects.toThrow(/ownership changed.*nonce/i);
    expect(JSON.parse(await readFile(ownerPath, "utf8"))).toEqual(successor);
  });

  it("fails closed with a bounded diagnostic for a malformed owner record", async () => {
    // Given: the shared owner path contains malformed state.
    const locks = join(root, "locks");
    await mkdir(locks, { recursive: true });
    const ownerPath = join(locks, "workspace-work-1.lock");
    await writeFile(ownerPath, "{partial");
    const clock = advancingClock(0);
    const state = new LifecycleState(root, { ...clock, waitTimeoutMs: 20, retryDelayMs: 5 });

    // When: acquisition exhausts its bounded wait.
    const acquisition = state.acquireWorkspaceLock("work-1");

    // Then: corruption is surfaced and never removed as stale state.
    await expect(acquisition).rejects.toThrow(/malformed owner record.*timed out/i);
    expect(await readFile(ownerPath, "utf8")).toBe("{partial");
  });

  it("fails closed when an owner boot ID has noncanonical hyphen placement", async () => {
    // Given: a 36-character owner boot ID has valid characters but misplaced hyphens.
    const locks = join(root, "locks");
    await mkdir(locks, { recursive: true });
    const ownerPath = join(locks, "workspace-work-1.lock");
    const ownerBytes = `${JSON.stringify({
      version: 1,
      pid: process.pid,
      bootId: "0000000-00000-0000-0000-000000000000",
      processStartTicks: "1",
      acquiredAt: "2026-09-13T00:00:00.000Z",
      nonce: "A".repeat(43)
    })}\n`;
    await writeFile(ownerPath, ownerBytes);
    const probeProcess = vi.fn(async (): Promise<"dead"> => "dead");
    const clock = advancingClock(0);
    const state = new LifecycleState(root, {
      ...clock,
      probeProcess,
      waitTimeoutMs: 20,
      retryDelayMs: 5
    });

    // When: acquisition retries until the configured deadline.
    const acquisition = state.acquireWorkspaceLock("work-1");

    // Then: malformed ownership is never probed, reclaimed, or rewritten.
    try {
      await expect(acquisition).rejects.toThrow(/malformed owner record.*timed out/i);
      expect(probeProcess).not.toHaveBeenCalled();
      expect(await readFile(ownerPath, "utf8")).toBe(ownerBytes);
    } finally {
      const release = await acquisition.catch(() => undefined);
      if (release !== undefined) await release();
    }
  });

  it.each(["EACCES", "EPERM"] as const)(
    "keeps an owner record fail-closed through the bounded retry deadline when reading returns %s",
    async (code) => {
      // Given: an existing owner record cannot be read while the bounded clock advances.
      const locks = join(root, "locks");
      await mkdir(locks, { recursive: true });
      const ownerPath = join(locks, "workspace-work-1.lock");
      const ownerBytes = "opaque owner bytes\n";
      await writeFile(ownerPath, ownerBytes);
      ownerReadFailures.failures.set(ownerPath, code);
      const clock = advancingClock(0);
      const state = new LifecycleState(root, { ...clock, waitTimeoutMs: 20, retryDelayMs: 5 });

      // When: acquisition retries until the configured deadline.
      const acquisition = state.acquireWorkspaceLock("work-1");

      // Then: every bounded attempt remains closed and the owner bytes are never reclaimed.
      await expect(acquisition).rejects.toThrow(new RegExp(`unreadable owner record.*${code}.*timed out`, "i"));
      expect(ownerReadFailures.attempts.get(ownerPath)).toBe(5);
      ownerReadFailures.failures.delete(ownerPath);
      expect(await readFile(ownerPath, "utf8")).toBe(ownerBytes);
    }
  );

  it("ignores and cleans an orphaned temporary owner publication", async () => {
    // Given: a crashed publisher left only its nonce-specific temporary file.
    const locks = join(root, "locks");
    await mkdir(locks, { recursive: true });
    const temporary = join(locks, "workspace-work-1.lock.tmp-orphan");
    await writeFile(temporary, "{partial");

    // When: a later process acquires and releases the lock.
    const release = await new LifecycleState(root).acquireWorkspaceLock("work-1");
    await release();

    // Then: incomplete unpublished bytes neither become ownership nor remain as state.
    await expect(readFile(temporary, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("serializes simultaneous reclaimers of a dead process owner", async () => {
    // Given: two child processes contend for one owner record abandoned by a dead child.
    const dead = startChild("work-1");
    await dead.ready();
    await dead.start();
    await dead.acquired();
    await dead.kill();
    const left = startChild("work-1");
    const right = startChild("work-1");
    await Promise.all([left.ready(), right.ready()]);

    // When: both reclaimers start together and one reports contention after the other acquires.
    await Promise.all([left.start(), right.start()]);
    await Promise.all([left.started(), right.started()]);
    const winner = await Promise.race([
      left.acquired().then(() => left),
      right.acquired().then(() => right)
    ]);
    const loser = winner === left ? right : left;
    await loser.contended();

    // Then: the second reclaimer enters only after the winner releases.
    await winner.release();
    await loser.retry();
    await loser.acquired();
    await loser.release();
  });

  it("bounds independent same-process acquisition and preserves lifecycle lock identities", async () => {
    // Given: the required Project, runner, hook, setup, and reconciliation lock identities are acquired in order.
    const state = new LifecycleState(root);
    const releaseProject = await state.acquireProjectLock("project");
    const releaseRunner = await state.acquireCiRunnerLock("project");
    const releaseHook = await state.acquireQemuProjectHookPublicationLock("project-id");
    const releaseSetup = await state.acquireWorkspaceSetupLock("work-1");
    const releaseWorkspace = await state.acquireWorkspaceLock("work-1");
    const clock = advancingClock(0);

    // When: an independent acquisition in this process contends for the workspace lock.
    const duplicate = new LifecycleState(root, {
      ...clock,
      waitTimeoutMs: 20,
      retryDelayMs: 5
    }).acquireWorkspaceLock("work-1");

    // Then: it times out while all distinct lock identities remain independently releasable.
    await expect(duplicate).rejects.toThrow(/timed out waiting for workspace 'work-1' reconciliation lock/);
    await releaseWorkspace();
    await releaseSetup();
    await releaseHook();
    await releaseRunner();
    await releaseProject();
  });
});
