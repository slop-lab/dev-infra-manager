import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import {
  compareAndSwapProtectedRef,
  finalizedProtectedRef,
  type ProtectedRefIntent,
  type ProtectedRefPorts,
} from "../../../packages/gs/repository/src/protected-ref.js";
import {
  cleanupRepositories,
  repositoryFixture,
} from "../../control-plane/plugins/git-repositories/protectedRefBoundaryFixture.js";

const execute = promisify(execFile);

afterEach(cleanupRepositories);

it("persists only the concrete GS authority fence and policy proof", async () => {
  const fixture = await repositoryFixture();
  const expectedTree = (await execute("/usr/bin/git", [
    "--git-dir",
    fixture.repository,
    "rev-parse",
    `${fixture.change.expectedCommit}^{tree}`,
  ])).stdout.trim();
  let recorded: ProtectedRefIntent | undefined;
  const ports: ProtectedRefPorts = {
    runtime: { gitExecutable: "/usr/bin/git", storageRoot: fixture.storageRoot },
    gitIdentity: fixture.gitIdentity,
    serialization: { kind: "already-exclusive" },
    targets: {
      async resolve() {
        return {
          selector: { namespaceId: "tenant", repositoryId: "main" },
          repositoryPath: fixture.repository,
          head: {
            sequence: 0,
            protectedRef: "refs/heads/main",
            commit: fixture.change.expectedCommit,
            tree: expectedTree,
          },
          incarnationId: "00000000-0000-4000-8000-000000000001",
          authorityEpoch: "c".repeat(64),
          policyDigest: "d".repeat(64),
          ownerPrincipalId: "repository-owner",
          refPolicyRevision: "e".repeat(64),
        };
      },
      async assertCurrent() {},
      async locateForRecovery() { return fixture.repository; },
    },
    policy: {
      async authorize() { return { refPolicyRevision: "e".repeat(64) }; },
    },
    journal: {
      findFinalized() { return recorded === undefined ? undefined : finalizedProtectedRef(recorded); },
      findFinalizedExact() { return recorded === undefined ? undefined : finalizedProtectedRef(recorded); },
      appendIntent(intent) { recorded = intent; },
      finalize() {},
      cancel() {},
      pending() { return recorded === undefined ? [] : [recorded]; },
    },
  };

  await expect(compareAndSwapProtectedRef(ports, fixture.change)).resolves.toEqual({
    outcome: "promoted",
    sequence: 1,
  });
  expect(recorded).toMatchObject({
    incarnationId: "00000000-0000-4000-8000-000000000001",
    authorityEpoch: "c".repeat(64),
    policyDigest: "d".repeat(64),
    ownerPrincipalId: "repository-owner",
    refPolicyRevision: "e".repeat(64),
  });
  expect(recorded).not.toHaveProperty("fence");
  expect(recorded).not.toHaveProperty("proof");
});
