import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const faults = vi.hoisted(() => ({ link: false, rename: false }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    link: vi.fn(async (...parameters: Parameters<typeof actual.link>) => {
      if (faults.link) {
        faults.link = false;
        throw Object.assign(new Error("injected backup publication failure"), { code: "EIO" });
      }
      return actual.link(...parameters);
    }),
    rename: vi.fn(async (...parameters: Parameters<typeof actual.rename>) => {
      if (faults.rename && String(parameters[1]).endsWith("host.json")) {
        faults.rename = false;
        throw Object.assign(new Error("injected canonical replacement failure"), { code: "EIO" });
      }
      return actual.rename(...parameters);
    })
  };
});

import { migrateHostLifecycleState } from "../../../../core/packages/core/src/hostStateMigration.js";
import { LifecycleState } from "../../../../core/packages/core/src/lifecycleState.js";

const schema1Bytes = `${JSON.stringify({
  schemaVersion: 1,
  phase: "stopped",
  resumeWorkspaces: ["workspace"],
  resumeCiRunners: [{ project: "example", name: "capacity" }],
  resumeManagedContainers: ["managed-service"],
  updatedAt: "2026-09-21T00:00:00.000Z"
}, null, 2)}\n`;

describe("host state migration fault recovery", () => {
  let root: string;
  let state: LifecycleState;

  beforeEach(async () => {
    faults.link = false;
    faults.rename = false;
    root = await mkdtemp(join(tmpdir(), "dim-host-migration-fault-"));
    state = new LifecycleState(root, { waitTimeoutMs: 100 });
    await writeFile(state.hostLifecyclePath(), schema1Bytes);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it.each(["link", "rename"] as const)("releases the lifecycle lock and converges after an injected %s fault", async (operation) => {
    // Given
    faults[operation] = true;

    // When
    const failed = migrateHostLifecycleState(state);

    // Then
    await expect(failed).rejects.toThrow(/injected/);
    await expect(readFile(join(root, "locks", "host-lifecycle.lock"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(migrateHostLifecycleState(state)).resolves.toEqual({ kind: "migrated" });
    expect(JSON.parse(await readFile(state.hostLifecyclePath(), "utf8"))).toMatchObject({
      schemaVersion: 2,
      restartCiRunners: [{ project: "example", name: "capacity" }]
    });
    expect(await readFile(join(root, "host.json.schema-1.bak"), "utf8")).toBe(schema1Bytes);
  });
});
