import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { basic, fixture, generationId, git, record, reviewer, token } from "../git-repositories/optionalFeaturesFixture.js";

it("authorizes resolution against current requirements rather than a stale reviewer's set", async () => {
  // Given: the old candidate requires owner, while the new tree requires security only.
  const security = { reviewerId: "security", username: "security", password: token(11) };
  const f = await fixture(true, [], { requiredReviewerIds: [], pathReviewerRules: [
    { pathPrefix: "README.md", reviewerIds: ["owner"] }, { pathPrefix: "security.txt", reviewerIds: ["security"] }
  ] }, [reviewer, security]);
  const proposalRef = "refs/heads/ordinary-review";
  const resolve = (credential: typeof reviewer) => fetch(`${f.origin}/v1/projects/project/repositories/main/reviews/resolve`, {
    method: "POST", headers: { authorization: basic(credential), "x-dim-generation-id": generationId, "content-type": "application/json" },
    body: JSON.stringify({ schemaVersion: 1, proposalRef })
  });
  try {
    await writeFile(join(f.source, "README.md"), "owner change\n"); await f.commit();
    await git("/usr/bin/git", ["-C", f.source, "push", "origin", `HEAD:${proposalRef}`]);
    const old = await resolve(reviewer);
    expect(old.status).toBe(200);
    expect(record(record(await old.json()).review).requiredReviewerIds).toEqual(["owner"]);
    await writeFile(join(f.source, "README.md"), "initial\n");
    await writeFile(join(f.source, "security.txt"), "security change\n");
    await git("/usr/bin/git", ["-C", f.source, "add", "."]); const candidate = await f.commit();
    // Model a committed ordinary source change before asynchronous reconciliation.
    await f.service.context.serialize(async () => {
      const repository = join(f.root, "state/project/main.git");
      await git("/usr/bin/git", ["-C", repository, "fetch", "--no-write-fetch-head", f.source, "HEAD"]);
      await git("/usr/bin/git", ["-C", repository, "update-ref", proposalRef, candidate]);
    });

    // When
    const current = await resolve(security);

    // Then
    expect(current.status, await current.clone().text()).toBe(200);
    expect(record(record(await current.json()).review)).toMatchObject({ candidateCommit: candidate, requiredReviewerIds: ["security"] });
    expect((await resolve(reviewer)).status).toBe(403);
  } finally { await f.service.close(); await rm(f.root, { recursive: true, force: true }); }
}, 20_000);
