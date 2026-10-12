import { link, mkdtemp, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { acquireNativeQemuHostCapacityGuard, acquireNativeQemuHostCapacityGuards,
  NativeQemuHostJournal } from "../../../../core/packages/core/src/nativeQemuHostJournal.js";
import { qemuAssignment as assignment, qemuTerminalEvent as terminalEvent } from "./nativeQemuHostFixture.js";

const claimId = "00000000-0000-4000-8000-000000000001";
const requestId = "00000000-0000-4000-8000-000000000003";

describe("native QEMU host journal", () => {
  it("durably preserves one claim request and its complete assignment", async () => {
    // Given
    const path = join(await mkdtemp(join(tmpdir(), "native-qemu-journal-")), "capacity", "journal.json");
    const journal = new NativeQemuHostJournal(path);

    // When
    await journal.save({ kind: "claim", requestId });
    const pending = await new NativeQemuHostJournal(path).load();
    await journal.save({ kind: "active", assignment });

    // Then
    expect(pending).toEqual({ kind: "claim", requestId });
    expect(await new NativeQemuHostJournal(path).load()).toEqual({ kind: "active", assignment });
  });

  it("durably replaces active ownership with the exact pending result", async () => {
    // Given
    const path = join(await mkdtemp(join(tmpdir(), "native-qemu-journal-")), "capacity", "journal.json");
    const journal = new NativeQemuHostJournal(path);

    // When
    await journal.save({ kind: "active", assignment });
    const active = await new NativeQemuHostJournal(path).load();
    await journal.save({ kind: "result", claimId, terminalEvent });

    // Then
    expect(active).toEqual({ kind: "active", assignment });
    expect(await new NativeQemuHostJournal(path).load()).toEqual({ kind: "result", claimId, terminalEvent });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("clears acknowledged state without removing its private parent", async () => {
    // Given
    const directory = join(await mkdtemp(join(tmpdir(), "native-qemu-journal-")), "capacity");
    const path = join(directory, "journal.json");
    const journal = new NativeQemuHostJournal(path);
    await journal.save({ kind: "active", assignment });

    // When
    await journal.clear();

    // Then
    expect(await journal.load()).toBeUndefined();
    expect((await stat(directory)).isDirectory()).toBe(true);
  });

  it("excludes a duplicate capacity process with a kernel lock", async () => {
    // Given
    const path = join(await mkdtemp(join(tmpdir(), "native-qemu-journal-")), "capacity", "journal.json");
    const first = await acquireNativeQemuHostCapacityGuard(path);

    // When
    const duplicate = acquireNativeQemuHostCapacityGuard(path);

    // Then
    try { await expect(duplicate).rejects.toThrow(/already served/); }
    finally { await first.release(); }
  });

  it("releases earlier capacity locks when all-capacity acquisition fails", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "native-qemu-journal-"));
    const firstPath = join(root, "first", "journal.json");
    const secondPath = join(root, "second", "journal.json");
    const blocker = await acquireNativeQemuHostCapacityGuard(secondPath);

    // When
    const acquisition = acquireNativeQemuHostCapacityGuards([firstPath, secondPath]);

    // Then
    try { await expect(acquisition).rejects.toThrow(/already served/); }
    finally { await blocker.release(); }
    const reacquired = await acquireNativeQemuHostCapacityGuard(firstPath);
    await reacquired.release();
  });

  it("rejects symlink and hard-linked journal state instead of adopting it", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "native-qemu-journal-"));
    const original = join(root, "capacity", "journal.json");
    const journal = new NativeQemuHostJournal(original);
    await journal.save({ kind: "claim", requestId });
    const linked = join(root, "linked.json");
    await link(original, linked);

    // When / Then
    await expect(journal.load()).rejects.toThrow(/journal.*invalid/);
    const symlinkPath = join(root, "symlink.json");
    await symlink(original, symlinkPath);
    await expect(new NativeQemuHostJournal(symlinkPath).load()).rejects.toThrow(/journal.*regular file/);
  });
});
