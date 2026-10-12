import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

const verificationRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const idleSmoke = join(verificationRoot, "scripts", "native-idle-service-images-smoke.bash");
const installerSmoke = join(verificationRoot, "scripts", "control-plane-install-live-smoke.bash");

test("uses current ordinary configuration and state formats", async () => {
  // Given / When
  const idle = await readFile(idleSmoke, "utf8");
  const installer = await readFile(installerSmoke, "utf8");

  // Then
  assert.match(idle, /schemaVersion:\s*5/);
  assert.match(idle, /eligibilityLeaseMilliseconds:\s*300000/);
  assert.match(idle, /writeFormat":12,"readableFormats":\[12\]/);
  assert.match(idle, /stateFormat":12/);
  assert.match(installer, /format_version=12/);
  assert.match(installer, /incompatible_format=13/);
  assert.doesNotMatch(idle, /admissionLeaseMilliseconds|credentials\.registrar/);
});

test("replaces manual admission operations with automatic eligibility and restart fencing", async () => {
  // Given / When
  const source = await readFile(idleSmoke, "utf8");

  // Then
  assert.doesNotMatch(source, /credentials\.registrar|native-root-admission\/(?:register|current|revoke)/);
  assert.match(source, /obsoleteOperations/);
  assert.match(source, /service\.createReview/);
  assert.match(source, /\/v1\/native-root-ci-events/);
  assert.match(source, /\/v1\/host-claims/);
  assert.match(source, /\/v1\/claim-reservation-verifications/);
  assert.match(source, /native-automatic-eligibility-restart-smoke-ok/);
});
