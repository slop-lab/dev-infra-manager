import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { configuredWebOperations } from "../../packages/web/core/src/operations.js";

it("allows a resource operation to finish beyond the ordinary thirty-second read deadline", async () => {
  const root = await mkdtemp(join(tmpdir(), "dim-web-resource-deadline-"));
  try {
    const executable = join(root, "dim");
    await writeFile(executable, `#!${process.execPath}\nsetTimeout(() => console.log("{}"), 31_000);\n`, { mode: 0o700 });
    const operations = configuredWebOperations({ hosts: [{ id: "fixture", selector: "fixture", executable }], consoles: [] });
    await expect(operations.workspaceAction("fixture", { name: "owned-fixture", expectedId: randomUUID(), action: "resources",
      resources: { cpuCount: "1", memory: "1g", pidsLimit: "512" } })).resolves.toBeUndefined();
  } finally { await rm(root, { recursive: true, force: true }); }
}, 45_000);
