import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  cleanupFixtureRoots,
  createFixture,
  createFixtureRoot,
  runBuilder,
  successfulGit
} from "./monorepoCandidateFixture.js";

afterEach(async () => { await cleanupFixtureRoots(); });

describe("single-tree candidate CI", () => {
  it("binds source and release jobs to one exact checkout and verifies committed provenance", async () => {
    // Given
    const sources = await createFixture();
    const root = await createFixtureRoot("dim-monorepo-evidence-");
    const candidate = resolve(root, "candidate");
    const built = runBuilder(candidate, sources);
    expect(built.status, built.stderr).toBe(0);
    const sha = successfulGit(candidate, ["rev-parse", "HEAD"]);
    const evidencePath = resolve(root, "candidate-evidence.json");
    const helper = resolve(candidate, "verification/scripts/monorepo-candidate-evidence.mjs");

    // When
    const verified = spawnSync("node", [helper, sha, evidencePath], { cwd: candidate, encoding: "utf8" });
    const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
    const sourceWorkflow = await readFile(resolve(candidate, ".gitea/workflows/verify.yml"), "utf8");
    const releaseWorkflow = await readFile(resolve(candidate, ".gitea/workflows/release-gate.yml"), "utf8");

    // Then
    expect(verified.status, verified.stderr).toBe(0);
    expect(evidence).toMatchObject({
      schemaVersion: 1,
      candidateCommit: sha,
      candidateTree: successfulGit(candidate, ["rev-parse", "HEAD^{tree}"]),
      sources: expect.arrayContaining(sources.filter((item) => item.name !== "github-development").map((item) => ({
        repository: item.name, destination: item.name === "development" ? "." : item.destination,
        sourceCommit: item.sha, sourceTree: item.tree
      }))),
      githubDevelopment: {
        commit: sources.find((item) => item.name === "github-development")?.sha,
        tree: sources.find((item) => item.name === "github-development")?.tree
      }
    });
    expect(parse(sourceWorkflow)).toMatchObject({
      permissions: { contents: "read" },
      jobs: { source: { "runs-on": "dim", steps: expect.arrayContaining([
        expect.objectContaining({
          uses: "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
          with: { ref: "${{ gitea.sha }}", "fetch-depth": 0, "persist-credentials": false }
        })
      ]) } }
    });
    expect(parse(releaseWorkflow)).toMatchObject({
      permissions: { contents: "read" },
      on: { workflow_dispatch: { inputs: { candidate_sha: { required: true } } } },
      jobs: {
        "container-integration": { "runs-on": "dim-container-integration", steps: expect.arrayContaining([
          expect.objectContaining({
            uses: "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
            with: { ref: "${{ inputs.candidate_sha }}", "fetch-depth": 0, "persist-credentials": false }
          })
        ]) },
        "qemu-sysbox": { "runs-on": "dim-qemu", steps: expect.arrayContaining([
          expect.objectContaining({
            uses: "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
            with: { ref: "${{ inputs.candidate_sha }}", "fetch-depth": 0, "persist-credentials": false }
          })
        ]) }
      }
    });
    expect(sourceWorkflow).not.toContain("dim-dim/verification/.gitea/workflows");
    expect(releaseWorkflow).not.toContain("dim-dim/verification/.gitea/workflows");
    expect(releaseWorkflow).not.toContain("root-ref");
    expect(sourceWorkflow).toContain("just check-source");
    expect(releaseWorkflow).toContain("just verify full-development");
    expect(releaseWorkflow).toContain("just verify environments-kvm");
    expect(releaseWorkflow.match(/test "\$DIM_EXPECTED_CANDIDATE_SHA" = "\$DIM_DISPATCH_SHA"/g)).toHaveLength(2);
  });

  it("rejects a changed overlay digest and a different checkout commit", async () => {
    // Given
    const sources = await createFixture();
    const root = await createFixtureRoot("dim-monorepo-evidence-reject-");
    const candidate = resolve(root, "candidate");
    expect(runBuilder(candidate, sources).status).toBe(0);
    const helper = resolve(candidate, "verification/scripts/monorepo-candidate-evidence.mjs");
    const sha = successfulGit(candidate, ["rev-parse", "HEAD"]);

    // When
    const wrongCommit = spawnSync("node", [helper, "0".repeat(40), resolve(root, "wrong.json")], {
      cwd: candidate, encoding: "utf8"
    });
    await writeFile(resolve(candidate, ".monorepo-candidate/overlay.digest"), `${"0".repeat(64)}\n`);
    const wrongDigest = spawnSync("node", [helper, sha, resolve(root, "tampered.json")], {
      cwd: candidate, encoding: "utf8"
    });

    // Then
    expect(wrongCommit.status).not.toBe(0);
    expect(wrongCommit.stderr).toContain("checked-out candidate commit does not match");
    expect(wrongDigest.status).not.toBe(0);
    expect(wrongDigest.stderr).toContain("overlay manifest digest changed");
  });
});
