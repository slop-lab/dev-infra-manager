import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const packageDirectory = fileURLToPath(new URL("..", import.meta.url));

test("DNS provider add exposes the common driver-owned argument contract", () => {
  const help = run(["external-url", "dns-provider", "add", "cloudflare", "--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--name <name>/);
  assert.match(help.stdout, /--argument <string>/);
  assert.doesNotMatch(help.stdout, /--zone|--record-type|--target|--credential-env/);

  const missingName = run(["external-url", "dns-provider", "add", "cloudflare"]);
  assert.notEqual(missingName.status, 0);
  assert.match(missingName.stderr, /required option '--name <name>' not specified/);
});

function run(args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: packageDirectory,
    encoding: "utf8"
  });
}
