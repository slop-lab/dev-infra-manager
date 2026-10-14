import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "vitest";

const source = await readFile(
  new URL("../scripts/control-plane-install-live-predecessor.mjs", import.meta.url),
  "utf8"
);

test("expects the native-only structural predecessor diagnostic", () => {
  assert.match(source, /Project-scoped CI runner state/);
  assert.doesNotMatch(source, /Sysbox CI runner state/);
});
