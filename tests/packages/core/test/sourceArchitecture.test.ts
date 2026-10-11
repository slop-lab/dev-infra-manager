import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runtimeSourceSccs } from "./sourceArchitecture.js";

const coreSourceDirectory = fileURLToPath(
  new URL("../../../../core/packages/core/src", import.meta.url)
);

describe("core source architecture", () => {
  const cleanup: string[] = [];
  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("detects recursive cycles through relative JavaScript imports and reexports", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "dim-source-scc-"));
    cleanup.push(directory);
    await mkdir(path.join(directory, "nested"));
    await Promise.all([
      writeFile(path.join(directory, "entry.ts"), 'export { value } from "./nested/value.js";\n'),
      writeFile(path.join(directory, "nested/value.ts"), 'import { entry } from "../entry.js";\nexport const value = entry;\n'),
      writeFile(path.join(directory, "types.ts"), 'import type { Value } from "./nested/value.js";\nexport type { Value };\n')
    ]);

    const components = await runtimeSourceSccs(directory);

    expect(components).toEqual([["entry.ts", "nested/value.ts"]]);
  });

  it("has no multi-module runtime strongly connected components", async () => {
    const components = await runtimeSourceSccs(coreSourceDirectory);

    expect(components).toEqual([]);
  });
});
