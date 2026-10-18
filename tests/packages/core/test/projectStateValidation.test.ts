import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MissingRecordError } from "../../../../core/packages/core/src/errors.js";
import { LifecycleState } from "../../../../core/packages/managed/src/lifecycleState.js";

describe("Project state", () => {
  it("distinguishes absent Project records from other storage errors", async () => {
    const root = await mkdtemp(join(tmpdir(), "dim-project-state-"));
    try {
      const missing = new LifecycleState(root).readProject("missing");
      await expect(missing).rejects.toEqual(expect.objectContaining({
        name: "MissingRecordError", message: "project 'missing' not found"
      }));
      await expect(missing).rejects.toBeInstanceOf(MissingRecordError);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
