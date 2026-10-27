import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { reviewPreparations, readAuthoritativeNativeReviewEnvelopes } from "@slop-lab/dim-control-plane-plugin-git-review/plugin-api";
import { authoritativePolicy, matchingRunner } from "../git-repositories/authoritativeNativeCandidateFixture.js";
import {
  cleanupFinalizeFixtures,
  createFinalizeRoot,
  createRootBundle,
  finalizeRootImport,
  generationId,
  importer,
  parseImportReceipt,
  projectInput,
  rootRepository,
  runGit,
  uploadRootBundle,
  workspaceWriteIssuerAuthorization
} from "../git-repositories/nativeRootImportFinalizeFixture.js";
import {
  addCandidateCommit,
  nativeBundleReviewFixture,
  reviewProposalRef,
  reviewWorkspaceId,
  waitForReadyReview,
  type NativeBundleReviewFixture
} from "./nativeBundleReviewFixture.js";
import { readRawProposalJobs } from "../../../../packages/control-plane/plugins/git-review/src/raw-proposal-journal.js";

afterEach(cleanupFinalizeFixtures);

it("prepares repository B while repository A preparation is blocked", async () => {
  // Given
  const fixture = await nativeBundleReviewFixture("raw-worker-blocked-a");
  const other = await addRepository(fixture, "other");
  const preparation = gitCiPreparation(fixture);
  const prepare = preparation.prepare;
  let entered: (() => void) | undefined;
  let release: (() => void) | undefined;
  const blocked = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  Object.defineProperty(preparation, "prepare", { value: async (input: Parameters<typeof prepare>[0]) => {
    if (input.selector.repositoryId === "root") { entered?.(); await gate; }
    return prepare(input);
  } });

  try {
    // When
    await addCandidateCommit(fixture.clone, "blocked-a.txt", Buffer.from("blocked A\n"));
    await runGit("/usr/bin/git", ["-C", fixture.clone, "push", "origin", `HEAD:${reviewProposalRef}`]);
    await blocked;
    await addCandidateCommit(other.clone, "ready-b.txt", Buffer.from("ready B\n"));
    const otherCommit = await head(other.clone);
    await runGit("/usr/bin/git", ["-C", other.clone, "push", "origin", `HEAD:${reviewProposalRef}`]);

    // Then
    await waitForReadyReview(rootRepository(fixture.root, "other"), otherCommit);
  } finally {
    release?.();
    Object.defineProperty(preparation, "prepare", { value: prepare });
  }
}, 30_000);

it("prepares repository B while repository A preparation persistently fails", async () => {
  // Given
  const fixture = await nativeBundleReviewFixture("raw-worker-poison-a");
  const other = await addRepository(fixture, "other");
  const preparation = gitCiPreparation(fixture);
  const prepare = preparation.prepare;
  Object.defineProperty(preparation, "prepare", { value: async (input: Parameters<typeof prepare>[0]) => {
    if (input.selector.repositoryId === "other") throw new Error("persistent repository A failure");
    return prepare(input);
  } });

  try {
    // When
    await addCandidateCommit(other.clone, "poison-a.txt", Buffer.from("poison A\n"));
    const otherCommit = await head(other.clone);
    await runGit("/usr/bin/git", ["-C", other.clone, "push", "origin", `HEAD:${reviewProposalRef}`]);
    await addCandidateCommit(fixture.clone, "ready-after-poison.txt", Buffer.from("ready B\n"));
    const rootCommit = await head(fixture.clone);
    await runGit("/usr/bin/git", ["-C", fixture.clone, "push", "origin", `HEAD:${reviewProposalRef}`]);

    // Then
    await waitForReadyReview(rootRepository(fixture.root), rootCommit);
    await expect.poll(() => rawState(fixture.root, "other", otherCommit)).toBe("failed");
  } finally {
    Object.defineProperty(preparation, "prepare", { value: prepare });
  }
}, 30_000);

it("honors the supplied publication hook and refuses ready after accepted hooks observe stale refs", async () => {
  // Given
  let publications = 0;
  const fixture = await nativeBundleReviewFixture("raw-worker-final-fence", {
    async publish(_input, publish) { publications += 1; return publish(); }
  });
  const preparation = gitCiPreparation(fixture);
  const accepted = preparation.accepted;
  if (accepted === undefined) throw new Error("fixture CI acceptance hook missing");
  let entered: (() => void) | undefined;
  let release: (() => void) | undefined;
  const blocked = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await addCandidateCommit(fixture.clone, "accepted-a.txt", Buffer.from("accepted A\n"));
  const candidateA = await head(fixture.clone);
  Object.defineProperty(preparation, "accepted", { value: async (input: Parameters<typeof accepted>[0]) => {
    if (input.envelope.review.candidateCommit === candidateA) { entered?.(); await gate; }
    return accepted(input);
  } });

  try {
    // When
    await runGit("/usr/bin/git", ["-C", fixture.clone, "push", "origin", `HEAD:${reviewProposalRef}`]);
    await blocked;
    await addCandidateCommit(fixture.clone, "accepted-b.txt", Buffer.from("accepted B\n"));
    const candidateB = await head(fixture.clone);
    await runGit("/usr/bin/git", ["-C", fixture.clone, "push", "origin", `HEAD:${reviewProposalRef}`]);
    release?.();

    // Then
    await expect.poll(() => rawState(fixture.root, "root", candidateA)).toBe("stale");
    await waitForReadyReview(rootRepository(fixture.root), candidateB);
    expect(publications).toBeGreaterThan(0);
    expect((await readAuthoritativeNativeReviewEnvelopes(rootRepository(fixture.root)))
      .some(({ review }) => review.candidateCommit === candidateA)).toBe(true);
  } finally {
    release?.();
    Object.defineProperty(preparation, "accepted", { value: accepted });
  }
}, 30_000);

function gitCiPreparation(fixture: NativeBundleReviewFixture) {
  const preparation = reviewPreparations(fixture.service.context.extensions).find(({ name }) => name === "git-ci");
  if (preparation === undefined) throw new Error("fixture CI preparation missing");
  return preparation;
}

async function addRepository(fixture: NativeBundleReviewFixture, repositoryId: string): Promise<{ readonly clone: string }> {
  const bundle = await createRootBundle({
    "README.md": `${repositoryId}\n`,
    ".dim/ci/runner.yml": matchingRunner(),
    ".dim/ci/jobs/source.bash": "set -euo pipefail\nprintf 'source\\n'\n",
    ".dim/ci/jobs/integration.bash": "set -euo pipefail\nprintf 'integration\\n'\n"
  });
  await fixture.service.prepareProject(generationId, importer.hostId, projectInput("project-a", repositoryId));
  const receipt = parseImportReceipt(await (await uploadRootBundle(
    fixture.service.origin, bundle, authoritativePolicy(["owner"], [], [
      { name: "integration", kind: "qemu", evidenceClass: "candidate-controlled" },
      { name: "source", kind: "ordinary-sysbox", evidenceClass: "candidate-controlled" }
    ], [repositoryId]), repositoryId
  )).json());
  const finalized = await finalizeRootImport(fixture.service.origin, {
    schemaVersion: 1, generationId, importNonce: receipt.importNonce, bundleDigest: receipt.bundleDigest
  }, undefined, repositoryId);
  expect(finalized.status).toBe(200);
  const lease = await fetch(`${fixture.service.origin}/v1/projects/project-a/repositories/${repositoryId}/workspace-write-leases`, {
    method: "POST",
    headers: { authorization: workspaceWriteIssuerAuthorization, "content-type": "application/json" },
    body: JSON.stringify({ schemaVersion: 1, generationId, repositoryId, workspaceId: reviewWorkspaceId })
  });
  expect(lease.status).toBe(201);
  const credentials: unknown = await lease.json();
  if (typeof credentials !== "object" || credentials === null) throw new Error("workspace lease missing");
  const username = Reflect.get(credentials, "username"), password = Reflect.get(credentials, "password");
  if (typeof username !== "string" || typeof password !== "string") throw new Error("workspace lease invalid");
  const clone = await createFinalizeRoot(`${repositoryId}-clone`);
  const remote = new URL(`/v1/projects/project-a/repositories/${repositoryId}.git`, fixture.service.origin);
  remote.username = username; remote.password = password;
  await runGit("/usr/bin/git", ["clone", remote.toString(), clone]);
  await runGit("/usr/bin/git", ["-C", clone, "config", "user.name", "DIM writer"]);
  await runGit("/usr/bin/git", ["-C", clone, "config", "user.email", "writer@example.invalid"]);
  await mkdir(join(clone, ".fixture"), { recursive: true });
  return { clone };
}

async function rawState(root: string, repositoryId: string, commit: string): Promise<string | undefined> {
  return (await readRawProposalJobs(rootRepository(root, repositoryId), generationId))
    .find(({ binding }) => binding.candidateCommit === commit)?.state.status;
}

async function head(clone: string): Promise<string> {
  return (await runGit("/usr/bin/git", ["-C", clone, "rev-parse", "HEAD"])).stdout.trim();
}
