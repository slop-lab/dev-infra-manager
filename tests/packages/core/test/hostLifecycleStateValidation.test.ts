import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MissingRecordError } from "../../../../core/packages/core/src/errors.js";
import { LifecycleState } from "../../../../core/packages/managed/src/lifecycleState.js";

const VALID_HOST_RECORD = {
  schemaVersion: 2,
  phase: "stopped",
  resumeWorkspaces: ["workspace"],
  updatedAt: "now",
  error: "interrupted"
} as const;

const HISTORICAL_SCHEMA_1_RECORD = {
  schemaVersion: 1,
  phase: "stopped",
  resumeWorkspaces: ["workspace"],
  updatedAt: "now"
} as const;

const MALFORMED_HOST_RECORDS = [
  ["missing phase", "phase", undefined],
  ["unsupported phase", "phase", "paused"],
  ["missing workspace array", "resumeWorkspaces", undefined],
  ["non-array workspaces", "resumeWorkspaces", "workspace"],
  ["non-string workspace member", "resumeWorkspaces", [7]],
  ["missing update timestamp", "updatedAt", undefined],
  ["non-string update timestamp", "updatedAt", 7],
  ["non-string error", "error", { message: "interrupted" }]
] as const;

const MALFORMED_RAW_HOST_STATES = [
  ["null document", null],
  ["array document", []],
  ["string document", "host lifecycle"],
  ["missing schema version", { ...VALID_HOST_RECORD, schemaVersion: undefined }],
  ["string schema version", { ...VALID_HOST_RECORD, schemaVersion: "2" }],
  ["unsupported schema version", { ...VALID_HOST_RECORD, schemaVersion: 3 }],
  ["unknown top-level field", { ...VALID_HOST_RECORD, futureState: true }],
] as const;

describe("host lifecycle state validation", () => {
  let root: string;
  let state: LifecycleState;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "dim-host-state-validation-"));
    state = new LifecycleState(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it.each(MALFORMED_HOST_RECORDS)("rejects schema 2 state with %s", async (_case, field, value) => {
    // Given
    await writeFile(state.hostLifecyclePath(), JSON.stringify({
      ...VALID_HOST_RECORD,
      [field]: value
    }));

    // When
    const read = state.readHostLifecycle();

    // Then
    await expect(read).rejects.toThrow();
  });

  it.each(MALFORMED_RAW_HOST_STATES)("rejects host state with %s", async (_case, rawState) => {
    // Given
    await writeFile(state.hostLifecyclePath(), JSON.stringify(rawState));

    // When
    const read = state.readHostLifecycle();

    // Then
    await expect(read).rejects.toThrow();
  });

  it("does not mutate malformed schema 2 state while rejecting it", async () => {
    // Given
    const rawState = `${JSON.stringify({ ...VALID_HOST_RECORD, phase: "paused" }, null, 4)}\n`;
    await writeFile(state.hostLifecyclePath(), rawState);

    // When
    const read = state.readHostLifecycle();

    // Then
    await expect(read).rejects.toThrow();
    await expect(readFile(state.hostLifecyclePath(), "utf8")).resolves.toBe(rawState);
  });

  it("rejects exact historical schema 1 state with export guidance without mutating it", async () => {
    // Given
    const rawState = `${JSON.stringify(HISTORICAL_SCHEMA_1_RECORD, null, 4)}\n`;
    await writeFile(state.hostLifecyclePath(), rawState);

    // When
    const read = state.readHostLifecycle();

    // Then
    await expect(read).rejects.toThrow(/unsupported predecessor state.*prior pinned release.*complete recovery/is);
    await expect(readFile(state.hostLifecyclePath(), "utf8")).resolves.toBe(rawState);
  });

  it("rejects malformed state whose validation error contains not found", async () => {
    // Given
    await writeFile(state.hostLifecyclePath(), JSON.stringify({
      ...VALID_HOST_RECORD,
      "not found": true
    }));

    // When
    const read = state.readHostLifecycle();

    // Then
    await expect(read).rejects.toThrow(/predecessor recovery targets.*prior pinned release/is);
  });

  it("types only an absent lifecycle record as missing while preserving its message", async () => {
    // Given
    const missingState = new LifecycleState(root).readProject("missing");

    // When / Then
    await expect(missingState).rejects.toEqual(expect.objectContaining({
      name: "MissingRecordError",
      message: "project 'missing' not found"
    }));
    await expect(missingState).rejects.toBeInstanceOf(MissingRecordError);
  });
});
