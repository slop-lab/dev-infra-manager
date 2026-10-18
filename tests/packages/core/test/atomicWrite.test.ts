import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import { atomicWrite } from "../../../../core/packages/core/src/lifecycleRecord.js";

it("publishes complete records for concurrent writes in the same clock tick", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dim-atomic-write-"));
  const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
  const records = Array.from({ length: 12 }, (_, index) => ({ index, content: String(index).repeat(64 * 1024) }));
  try {
    await Promise.all(records.map((record) => atomicWrite(join(directory, "selection.json"), record)));
    const actual = JSON.parse(await readFile(join(directory, "selection.json"), "utf8"));
    expect(records).toContainEqual(actual);
    expect(await readdir(directory)).toEqual(["selection.json"]);
  } finally { clock.mockRestore(); await rm(directory, { recursive: true, force: true }); }
});

it("removes its temporary file if a record cannot be serialized", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dim-atomic-write-"));
  try {
    await expect(atomicWrite(join(directory, "selection.json"), { unsupported: 1n })).rejects.toThrow();
    expect(await readdir(directory)).toEqual([]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
