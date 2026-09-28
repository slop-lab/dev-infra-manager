import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cli = fileURLToPath(new URL("../../../../core/packages/cli/src/cli.ts", import.meta.url));
const packageDirectory = fileURLToPath(new URL("../../../../core/packages/cli", import.meta.url));
const tsxImport = import.meta.resolve("tsx");

test("repository apply exposes only the explicit root-origin rebind contract", () => {
  const help = run(["repo", "apply", "--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--rebind-origin <alias>/);
  assert.match(help.stdout, /--expect-origin-tip <full-sha>/);

  for (const args of [
    ["repo", "apply", "acme", "--rebind-origin", "root", "--expect-origin-tip", "2".repeat(40)],
    ["repo", "apply", "acme", "--rebind-origin", "root", "--yes"],
    ["repo", "apply", "acme", "--expect-origin-tip", "2".repeat(40), "--yes"],
    ["repo", "apply", "acme", "--rebind-origin", "root", "--expect-origin-tip", "A".repeat(40), "--yes"]
  ]) {
    const result = run(args);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /--rebind-origin, --expect-origin-tip, and --yes|40 lowercase hexadecimal/);
  }
});

function run(args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, ["--import", tsxImport, cli, ...args], {
    cwd: packageDirectory,
    encoding: "utf8"
  });
}
