import { appendFile, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { boundedMonitorJson } from "./monitorCommand.js";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});
afterEach(() => vi.restoreAllMocks());

it("rejects metadata that grows beyond the byte bound after its size was observed", async () => {
  const root = await mkdtemp(join(tmpdir(), "dim-growing-monitor-")), path = join(root, "metadata.json");
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  try {
    await writeFile(path, "{}", { mode: 0o600 });
    vi.mocked(open).mockImplementationOnce(async (...args) => {
      const file = await actual.open(...args), observed = await file.stat();
      await appendFile(path, " ".repeat(2 * 1024 * 1024));
      vi.spyOn(file, "stat").mockResolvedValueOnce(observed);
      return file;
    });
    await expect(boundedMonitorJson(path)).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});
