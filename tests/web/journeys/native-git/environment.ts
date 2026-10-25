import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createNativeManagementBrowserFixture } from "../../plugins/nativeManagementBrowserFixture.js";
import { generationId, hostPromoter, humanReviewer, workspaceWriteIssuer, runGit } from "../../../control-plane/plugins/git-repositories/nativeRootImportFinalizeFixture.js";

/** Disposable real Web, host plugin and Git authority. Only upstream HTTPS
 * transport is redirected to a local Git server; no browser operation is mocked.
 * Initial browser roles remain those produced by initializeOperationsWeb. */
export async function createReviewEnvironment() {
  const fixture = await createNativeManagementBrowserFixture();
  let checkout: string | undefined;
  let proposalRef: string | undefined;
  let proposalCommit: string | undefined;
  try {
    await writeFile(join(fixture.managed.root, "promoter.json"), JSON.stringify({ schemaVersion: 1, serviceId: "native-main",
      endpoint: fixture.managed.service.origin, generationId, role: "host-promoter", hostId: hostPromoter.hostId,
      credential: { username: hostPromoter.username, password: hostPromoter.password } }), { mode: 0o600 });
    return {
      origin: fixture.origin, username: fixture.username, password: fixture.password,
      projectId: "review-journey", repositoryId: "public", upstreamUrl: "https://github.com/mjy9088/codyssey-public.git",
      async prepareProposal() {
        const base = `${fixture.managed.service.origin}/v1/projects/review-journey/repositories/public`;
        const workspaceId = Buffer.alloc(32, 91).toString("base64url");
        const response = await fetch(base + "/workspace-write-leases", { method: "POST", headers: {
          authorization: `Basic ${Buffer.from(`${workspaceWriteIssuer.username}:${workspaceWriteIssuer.password}`).toString("base64")}`,
          "content-type": "application/json", "x-dim-generation-id": generationId
        }, body: JSON.stringify({ schemaVersion: 1, generationId, repositoryId: "public", workspaceId }) });
        assert.equal(response.status, 201, "workspace proposal lease must be issued");
        const lease: unknown = await response.json();
        assert(lease !== null && typeof lease === "object" && "username" in lease && typeof lease.username === "string"
          && "password" in lease && typeof lease.password === "string", "workspace lease is valid");
        const remote = new URL(base + ".git"); remote.username = lease.username; remote.password = lease.password;
        checkout = join(fixture.managed.root, "journey-checkout");
        await runGit("/usr/bin/git", ["clone", "--quiet", remote.toString(), checkout]);
        const baseCommit = (await runGit("/usr/bin/git", ["-C", checkout, "rev-parse", "HEAD"])).stdout.trim();
        await mkdir(join(checkout, ".dim"));
        await writeFile(join(checkout, ".dim", "review-boundary.json"), '{"requiresReview":true}\n');
        await runGit("/usr/bin/git", ["-C", checkout, "add", ".dim"]);
        await runGit("/usr/bin/git", ["-C", checkout, "-c", "user.name=DIM Journey", "-c", "user.email=journey@example.invalid", "commit", "--quiet", "-m", "change reviewed configuration"]);
        const candidate = (await runGit("/usr/bin/git", ["-C", checkout, "rev-parse", "HEAD"])).stdout.trim();
        proposalCommit = candidate;
        proposalRef = `refs/heads/review-boundary-${workspaceId}`;
        await runGit("/usr/bin/git", ["-C", checkout, "push", "--quiet", "origin", `HEAD:${proposalRef}`]);
        // Another reviewer has prepared pending evidence. The browser's initial
        // operator still cannot resolve/approve; it must discover and obtain that
        // access through the actual account UI before exercising those actions.
        const review = await fetch(base + "/reviews/resolve", { method: "POST", headers: {
          authorization: `Basic ${Buffer.from(`${humanReviewer.username}:${humanReviewer.password}`).toString("base64")}`,
          "content-type": "application/json", "x-dim-generation-id": generationId
        }, body: JSON.stringify({ schemaVersion: 1, proposalRef, protectedRef: "refs/heads/main" }) });
        assert.equal(review.status, 200, "pending review fixture evidence must be prepared");
        return { candidate, proposalRef, baseCommit };
      },
      async advanceProposal() {
        assert(checkout && proposalRef && proposalCommit, "a workspace proposal must exist before rewriting its revision");
        const previousCandidate = proposalCommit;
        const baseCommit = (await runGit("/usr/bin/git", ["-C", checkout, "rev-parse", `${previousCandidate}^`])).stdout.trim();
        await runGit("/usr/bin/git", ["-C", checkout, "reset", "--hard", baseCommit]);
        await mkdir(join(checkout, ".dim"));
        await writeFile(join(checkout, ".dim", "review-boundary.json"), '{"requiresReview":true,"revision":2}\n');
        await runGit("/usr/bin/git", ["-C", checkout, "add", ".dim/review-boundary.json"]);
        await runGit("/usr/bin/git", ["-C", checkout, "-c", "user.name=DIM Journey", "-c", "user.email=journey@example.invalid", "commit", "--quiet", "-m", "rewrite reviewed configuration"]);
        const candidate = (await runGit("/usr/bin/git", ["-C", checkout, "rev-parse", "HEAD"])).stdout.trim();
        assert.notEqual(candidate, previousCandidate, "rewritten source must produce a different candidate commit");
        assert.equal((await runGit("/usr/bin/git", ["-C", checkout, "rev-parse", `${candidate}^`])).stdout.trim(), baseCommit,
          "rewritten source must replace rather than descend from the reviewed candidate");
        await runGit("/usr/bin/git", ["-C", checkout, "push", "--quiet", `--force-with-lease=${proposalRef}:${previousCandidate}`, "origin", `HEAD:${proposalRef}`]);
        proposalCommit = candidate;
        return { candidate, previousCandidate, proposalRef };
      },
      async assertProtectedHead(candidate: string) {
        const actual = (await runGit("/usr/bin/git", ["--git-dir", join(fixture.managed.serviceRoot, "review-journey", "public.git"), "rev-parse", "refs/heads/main"])).stdout.trim();
        assert.equal(actual, candidate, "UI promotion must update the actual protected Git ref");
      },
      async assertProjectImported() {
        const project = await fixture.managed.store.read("review-journey", fixture.managed.connection.hostId);
        assert.equal(project?.phase, "ready");
        assert(project.repositories.public, "UI import must persist the selected repository");
      },
      close: () => fixture.close()
    };
  } catch (error) { await fixture.close(); throw error; }
}

export type ReviewEnvironment = Awaited<ReturnType<typeof createReviewEnvironment>>;
