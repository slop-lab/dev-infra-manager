import { strict as assert } from "node:assert";
import { describe, it } from "vitest";
import {
  candidateCompatibilityDenials,
  parseCompatibilityVariantManifest,
  priorCompatibilityDenials
} from "../scripts/control-plane-install-live-compatibility.mjs";

describe("control-plane live compatibility denial matrix", () => {
  it("names every candidate and prior incompatibility class", () => {
    // Given
    const expectedCandidateProfiles = [
      "compatibility-missing-field",
      "compatibility-malformed-json",
      "candidate-write-unreadable-by-prior",
      "non-overlapping-formats",
      "candidate-state-format-mismatch"
    ];
    const expectedPriorProfiles = [
      "prior-write-unreadable-by-candidate",
      "prior-state-format-mismatch"
    ];

    // When
    const candidateProfiles = candidateCompatibilityDenials.map(({ profile }) => profile);
    const priorProfiles = priorCompatibilityDenials.map(({ profile }) => profile);

    // Then
    assert.deepEqual(candidateProfiles, expectedCandidateProfiles);
    assert.deepEqual(priorProfiles, expectedPriorProfiles);
  });

  it("requires one immutable variant digest per profile and service", () => {
    // Given
    const profiles = [...candidateCompatibilityDenials, ...priorCompatibilityDenials].map(({ profile }) => profile);
    const lines = profiles.flatMap((profile) => [
      `nativeGit\t${profile}\t127.0.0.1:5000/test/native@sha256:${"a".repeat(64)}`,
      `ordinaryCi\t${profile}\t127.0.0.1:5000/test/ordinary@sha256:${"b".repeat(64)}`
    ]).join("\n");

    // When
    const manifest = parseCompatibilityVariantManifest(`${lines}\n`);

    // Then
    assert.equal(Object.keys(manifest.nativeGit).length, profiles.length);
    assert.equal(Object.keys(manifest.ordinaryCi).length, profiles.length);
    assert.match(manifest.nativeGit[profiles[0]], /@sha256:[0-9a-f]{64}$/);
  });
});
