import { strict as assert } from "node:assert";
import { test } from "node:test";
import { sanitizeGitReadDiagnostic } from "./native-git-read-evidence.js";

test("Git evidence preserves transport failure details without authentication or remote response bodies", () => {
  // Given stderr with a useful local transport error and private credentials/body.
  const input = "Authorization: Bearer fixture-token\n"
    + "fatal: unable to access https://operator:fixture-password@example.invalid/repo?token=fixture-query\n"
    + "error: RPC failed; curl 18 transfer closed with outstanding read data remaining\n"
    + "remote: private-response-body\n"
    + "password=fixture-password\n";
  // When evidence is sanitized before retention.
  const result = sanitizeGitReadDiagnostic(input);
  // Then transport evidence survives, but credentials and response bodies do not.
  assert.match(result, /RPC failed; curl 18/);
  for (const secret of ["fixture-token", "fixture-password", "fixture-query", "private-response-body"]) {
    assert.equal(result.includes(secret), false);
  }
});

test("Git evidence bounds retained diagnostics after sanitization", () => {
  // Given an arbitrarily long diagnostic.
  const input = "fatal: " + "x".repeat(20_000);
  // When it crosses the evidence boundary.
  const result = sanitizeGitReadDiagnostic(input);
  // Then retained output has a finite budget.
  assert.ok(Buffer.byteLength(result, "utf8") <= 2_048);
});
