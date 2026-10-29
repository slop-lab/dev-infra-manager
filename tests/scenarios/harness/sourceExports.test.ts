import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

it("uses package exports for explicit source resolution without exposing private subpaths", () => {
  for (const source of [false, true]) {
    const result = spawnSync(process.execPath, [
      ...(source ? ["--conditions=source", "--import", createRequire(import.meta.url).resolve("tsx")] : []), "--input-type=module", "-e", `
        const entry = import.meta.resolve('@slop-lab/gs-repository-contracts');
        await import('@slop-lab/gs-repository-contracts');
        try { import.meta.resolve('@slop-lab/gs-repository-contracts/src/index.ts'); throw Error('private path resolved'); }
        catch (error) { if (error.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error; }
        console.log(entry);
      `
    ], { cwd: new URL("../..", import.meta.url), encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toMatch(source ? /\/src\/index\.ts$/ : /\/dist\/index\.js$/);
  }
});

it("shares source module identity across bare package exports and direct owner imports", async () => {
  const selected = await import("@slop-lab/gs-repository-contracts");
  const source = await import("../../../packages/gs/repository-contracts/src/index.js");
  expect(selected.repositoryPolicyRevision).toBe(source.repositoryPolicyRevision);
});
