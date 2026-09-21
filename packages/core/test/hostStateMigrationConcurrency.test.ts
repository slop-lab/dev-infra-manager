import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrateHostLifecycleState } from "../../../../core/packages/core/src/hostStateMigration.js";
import { LifecycleState } from "../../../../core/packages/core/src/lifecycleState.js";

const schema1Bytes = `${JSON.stringify({
  schemaVersion: 1,
  phase: "stopped",
  resumeWorkspaces: ["workspace"],
  resumeCiRunners: [{ project: "example", name: "capacity" }],
  resumeManagedContainers: ["managed-service"],
  updatedAt: "2026-09-21T00:00:00.000Z"
}, null, 4)}\n`;

describe("host state migration concurrency", () => {
  let root: string;
  let state: LifecycleState;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "dim-host-migration-concurrency-"));
    state = new LifecycleState(root, { waitTimeoutMs: 2_000, retryDelayMs: 1 });
    await writeFile(state.hostLifecyclePath(), schema1Bytes);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("serializes concurrent callers and converges on one permanent backup", async () => {
    // Given / When
    const results = await Promise.all(Array.from({ length: 8 }, async () => migrateHostLifecycleState(state)));

    // Then
    expect(results.filter((result) => result.kind === "migrated")).toHaveLength(1);
    expect(results.filter((result) => result.kind === "unchanged")).toHaveLength(7);
    expect(await readFile(join(root, "host.json.schema-1.bak"), "utf8")).toBe(schema1Bytes);
    expect(JSON.parse(await readFile(state.hostLifecyclePath(), "utf8"))).toMatchObject({ schemaVersion: 2 });
  });

  it("shows active readers only complete schema 1 or complete schema 2 bytes", async () => {
    // Given
    const observed = new Set<string>();
    let reading = true;
    let confirmInitialRead: (() => void) | undefined;
    const initialRead = new Promise<void>((resolve) => { confirmInitialRead = resolve; });
    const reader = (async () => {
      while (reading) {
        observed.add(await readFile(state.hostLifecyclePath(), "utf8"));
        confirmInitialRead?.();
        confirmInitialRead = undefined;
      }
    })();
    await initialRead;

    // When
    await migrateHostLifecycleState(state);
    const finalBytes = await readFile(state.hostLifecyclePath(), "utf8");
    observed.add(finalBytes);
    reading = false;
    await reader;

    // Then
    expect(observed.has(schema1Bytes)).toBe(true);
    expect(observed.has(finalBytes)).toBe(true);
    expect([...observed].every((bytes) => bytes === schema1Bytes || bytes === finalBytes)).toBe(true);
    expect(JSON.parse(finalBytes)).toMatchObject({ schemaVersion: 2 });
  });
});
