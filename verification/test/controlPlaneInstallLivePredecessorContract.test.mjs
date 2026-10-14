import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "vitest";

const source = await readFile(
  new URL("../scripts/control-plane-install-live-predecessor.mjs", import.meta.url),
  "utf8"
);

test("expects the native-only structural predecessor diagnostic", () => {
  for (const name of [
    "schema8-sysbox",
    "malformed-runner",
    "unsupported-runner",
    "foreign-owned-runner",
    "schema8-qemu"
  ]) {
    assert.match(source, new RegExp(`runDenial\\(context, "${name}", recordPath, /Project-scoped CI runner state/`));
  }
  assert.match(source,
    /runDenial\(context, "symlinked-runner", external, \/canonical CI runner record\.\*symbolic link\//);
  assert.match(source, /writeFile\(path, bytes, \{ mode: 0o600 \}\)/);
  assert.match(source, /chmod\(path, 0o600\)/);
  assert.match(source, /rename\(recordPath, archivedFixture\)/);
  assert.match(source, /return \{ recordPath: archivedFixture, qemuBytes \}/);
  assert.match(source, /assert\.deepEqual\(await readFile\(input\.recordPath\), input\.qemuBytes\)/);
  assert.doesNotMatch(source, /Sysbox CI runner state/);
});
