import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cli = fileURLToPath(new URL("../../../../core/packages/cli/src/cli.ts", import.meta.url));
const packageDirectory = fileURLToPath(new URL("../../../../core/packages/cli", import.meta.url));
const tsxImport = import.meta.resolve("tsx");

test("native root bootstrap help requires explicit local source and separate operator connections", () => {
  const help = spawnSync(process.execPath, ["--import", tsxImport, cli,
    "project", "bootstrap-native-root", "--help"], { cwd: packageDirectory, encoding: "utf8" });

  assert.equal(help.status, 0);
  for (const option of ["--project-id <project-id>", "--source-repository <absolute-path>",
    "--source-ref <full-branch-ref>", "--registrar-connection <absolute-path>",
    "--importer-connection <absolute-path>", "--git-executable <absolute-path>"]) {
    assert.match(help.stdout, new RegExp(option.replace(/[<>]/g, "\\$&")));
  }
  assert.doesNotMatch(help.stdout, /bootstrap-git-url|password|token/);
});
