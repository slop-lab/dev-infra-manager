import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NativeOrdinaryHostJournal } from "../../../../core/packages/core/src/nativeOrdinaryHostJournal.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("native ordinary host journal", () => {
  it("durably stores exact request bytes without credentials using owner-only modes", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "dim-native-journal-test-"));
    roots.push(root);
    const directory = join(root, "capacity");
    const path = join(directory, "journal.json");
    const request = {
      requestId: "90000000-0000-4000-8000-000000000001",
      body: "{\"schemaVersion\":1,\"requestId\":\"90000000-0000-4000-8000-000000000001\",\"hostId\":\"host-a\",\"capacity\":\"primary\"}"
    } as const;
    const journal = new NativeOrdinaryHostJournal(path);

    // When
    await journal.save({ kind: "claim", request });
    const loaded = await journal.load();

    // Then
    expect(loaded).toEqual({ kind: "claim", request });
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const bytes = await readFile(path, "utf8");
    expect(bytes).toContain(request.body.replaceAll("\"", "\\\""));
    expect(bytes).not.toMatch(/authorization|password|token/i);
  });
});
