import type { FileHandle } from "node:fs/promises";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const faultState = vi.hoisted<{
  active: string | undefined;
  canonicalOpens: number;
  directoryPhase: string | undefined;
}>(() => ({
  active: undefined,
  canonicalOpens: 0,
  directoryPhase: undefined
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();

  function inject(point: string): void {
    if (faultState.active !== point) return;
    faultState.active = undefined;
    throw Object.assign(new Error(`injected ${point} failure`), { code: "EIO" });
  }

  function wrapHandle(handle: FileHandle, phase: string | undefined): FileHandle {
    return new Proxy(handle, {
      get(target, property) {
        if (property === "writeFile") {
          return async (...parameters: Parameters<FileHandle["writeFile"]>) => {
            const result = await target.writeFile(...parameters);
            inject(`${phase}-write`);
            return result;
          };
        }
        if (property === "readFile") {
          return async (...parameters: Parameters<FileHandle["readFile"]>) => {
            const result = await target.readFile(...parameters);
            inject(`${phase}-read`);
            return result;
          };
        }
        if (property === "sync") {
          return async () => {
            await target.sync();
            inject(`${phase}-fsync`);
          };
        }
        if (property === "close") {
          return async () => {
            await target.close();
            inject(`${phase}-close`);
          };
        }
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
    });
  }

  return {
    ...actual,
    open: vi.fn(async (...parameters: Parameters<typeof actual.open>) => {
      const target = String(parameters[0]);
      let phase: string | undefined;
      if (target.includes("schema-1.backup.tmp-")) phase = "backup-temp";
      else if (target.includes("schema-2.replace.tmp-")) phase = "schema2-temp";
      else if (target.endsWith("host.json")) {
        faultState.canonicalOpens += 1;
        if (faultState.canonicalOpens === 2) phase = "final-canonical";
      } else if (faultState.directoryPhase !== undefined) {
        phase = faultState.directoryPhase;
        faultState.directoryPhase = undefined;
      }
      inject(`${phase}-open`);
      return wrapHandle(await actual.open(...parameters), phase);
    }),
    link: vi.fn(async (...parameters: Parameters<typeof actual.link>) => {
      const result = await actual.link(...parameters);
      faultState.directoryPhase = "backup-publication-directory";
      inject("backup-publication");
      return result;
    }),
    rename: vi.fn(async (...parameters: Parameters<typeof actual.rename>) => {
      const result = await actual.rename(...parameters);
      if (String(parameters[1]).endsWith("host.json")) {
        faultState.directoryPhase = "target-rename-directory";
        inject("target-rename");
      }
      return result;
    }),
    rm: vi.fn(async (...parameters: Parameters<typeof actual.rm>) => {
      const result = await actual.rm(...parameters);
      const target = String(parameters[0]);
      if (target.includes("schema-1.backup.tmp-")) {
        faultState.directoryPhase = "backup-cleanup-directory";
        inject("backup-temp-remove");
      } else if (target.includes("schema-2.replace.tmp-")) {
        faultState.directoryPhase = "schema2-cleanup-directory";
        inject("schema2-temp-remove");
      }
      return result;
    })
  };
});

import { migrateHostLifecycleState } from "../../../../core/packages/core/src/hostStateMigration.js";
import { LifecycleState } from "../../../../core/packages/core/src/lifecycleState.js";

const SCHEMA_1_BYTES = `${JSON.stringify({
  schemaVersion: 1,
  phase: "stopped",
  resumeWorkspaces: ["workspace"],
  resumeCiRunners: [{ project: "example", name: "capacity" }],
  resumeManagedContainers: ["managed-service"],
  updatedAt: "2026-09-21T00:00:00.000Z"
}, null, 2)}\n`;
const SCHEMA_2_BYTES = `${JSON.stringify({
  schemaVersion: 2,
  phase: "stopped",
  resumeWorkspaces: ["workspace"],
  restartCiRunners: [{ project: "example", name: "capacity" }],
  resumeManagedContainers: ["managed-service"],
  updatedAt: "2026-09-21T00:00:00.000Z"
}, null, 2)}\n`;
const FAULT_POINTS = [
  "backup-temp-open",
  "backup-temp-write",
  "backup-temp-fsync",
  "backup-temp-close",
  "backup-publication",
  "backup-publication-directory-fsync",
  "backup-temp-remove",
  "backup-cleanup-directory-fsync",
  "schema2-temp-open",
  "schema2-temp-write",
  "schema2-temp-fsync",
  "schema2-temp-close",
  "target-rename",
  "target-rename-directory-fsync",
  "schema2-temp-remove",
  "schema2-cleanup-directory-fsync",
  "final-canonical-open",
  "final-canonical-read",
  "final-canonical-close"
] as const;

describe("host state migration fault recovery", () => {
  let root: string;
  let state: LifecycleState;

  beforeEach(async () => {
    faultState.active = undefined;
    faultState.canonicalOpens = 0;
    faultState.directoryPhase = undefined;
    root = await mkdtemp(join(tmpdir(), "dim-host-migration-fault-"));
    state = new LifecycleState(root, { waitTimeoutMs: 100 });
    await writeFile(state.hostLifecyclePath(), SCHEMA_1_BYTES);
    await writeFile(join(root, "unrelated"), "preserve me\n");
  });

  afterEach(async () => {
    faultState.active = undefined;
    await rm(root, { recursive: true, force: true });
  });

  it.each(FAULT_POINTS)("preserves durable state and converges after an injected %s fault", async (faultPoint) => {
    // Given
    faultState.active = faultPoint;

    // When
    const failed = migrateHostLifecycleState(state);

    // Then
    await expect(failed).rejects.toThrow(`injected ${faultPoint} failure`);
    await expect(readFile(join(root, "locks", "host-lifecycle.lock"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
    const failedCanonical = await readFile(state.hostLifecyclePath(), "utf8");
    expect([SCHEMA_1_BYTES, SCHEMA_2_BYTES]).toContain(failedCanonical);
    expect(() => JSON.parse(failedCanonical)).not.toThrow();
    await expect(readFile(join(root, "unrelated"), "utf8")).resolves.toBe("preserve me\n");

    faultState.canonicalOpens = 0;
    await expect(migrateHostLifecycleState(state)).resolves.toEqual({
      kind: failedCanonical === SCHEMA_1_BYTES ? "migrated" : "unchanged"
    });
    await expect(readFile(state.hostLifecyclePath(), "utf8")).resolves.toBe(SCHEMA_2_BYTES);
    const backupPath = join(root, "host.json.schema-1.bak");
    await expect(readFile(backupPath, "utf8")).resolves.toBe(SCHEMA_1_BYTES);
    const backupIdentity = await lstat(backupPath);

    faultState.canonicalOpens = 0;
    await expect(migrateHostLifecycleState(state)).resolves.toEqual({ kind: "unchanged" });
    expect((await lstat(backupPath)).ino).toBe(backupIdentity.ino);
    await expect(readFile(backupPath, "utf8")).resolves.toBe(SCHEMA_1_BYTES);
    await expect(readFile(join(root, "unrelated"), "utf8")).resolves.toBe("preserve me\n");
  });
});
