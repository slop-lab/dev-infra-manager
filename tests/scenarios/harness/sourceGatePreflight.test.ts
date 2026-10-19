import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";

const script = resolve(import.meta.dirname, "../../../scripts/checks/source-gate-preflight.bash");
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function run(node: string, pnpm: string, missingTemporary = false) {
  const root = await mkdtemp(join(tmpdir(), "dim-source-preflight-")); roots.push(root);
  const tools = join(root, "tools"); await mkdir(tools);
  for (const [name, version] of Object.entries({ node, pnpm, just: "just", python3: "Python 3" })) {
    const path = join(tools, name);
    await writeFile(path, `#!/bin/sh\nprintf '%s\\n' '${version}'\n`); await chmod(path, 0o755);
  }
  const result = spawnSync("/bin/bash", [script], { encoding: "utf8", env: {
    PATH: `${tools}:/usr/bin:/bin`, TMPDIR: missingTemporary ? join(root, "missing") : root
  } });
  return { result, root };
}
it("accepts ordinary developer prerequisites without root ownership or an exact Git pin", async () => {
  const { result } = await run("v26.5.0", "10.13.1");
  expect(result.status, result.stderr).toBe(0);
});
it("reports unsupported runtimes and unusable temporary storage together", async () => {
  const { result } = await run("v25.0.0", "11.0.0", true);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("unsupported Node.js");
  expect(result.stderr).toContain("unsupported pnpm");
  expect(result.stderr).toContain("TMPDIR");
});
