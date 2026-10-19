// @ts-check
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "vitest";

const checker = new URL("../../../scripts/checks/lib/check-installation-docker-version.bash", import.meta.url);

test("accepts each reviewed installation Docker version", () => {
  // Given
  const reviewedVersions = ["29.1.3", "29.1.4"];

  // When
  const results = reviewedVersions.map((version) => spawnSync("bash", [checker.pathname, version], { encoding: "utf8" }));

  // Then
  for (const result of results) {
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  }
});

test("rejects Docker versions outside the exact reviewed set", () => {
  // Given
  const unreviewedVersions = ["29.1.2", "29.1.5", "29.1.4+unreviewed", "30.0.0"];

  // When
  const results = unreviewedVersions.map((version) => spawnSync("bash", [checker.pathname, version], { encoding: "utf8" }));

  // Then
  for (const [index, result] of results.entries()) {
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, `unsupported installation Docker server version: ${unreviewedVersions[index]}\n`);
  }
});
