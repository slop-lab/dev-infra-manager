import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { currentRevision, parsePullRequest } from "@slop-lab/git-pull-requests";
import { createNativeGitOperator } from "../../packages/service-clients/native-git/src/operator.js";
import { controlPlanePlugin as pullRequests } from "../../packages/control-plane/plugins/git-pull-requests/src/index.js";
import { controlPlanePlugin as mergePolicy } from "../../packages/control-plane/plugins/git-merge-policy/src/index.js";
import { fixture, generationId, git, reviewer, token } from "../control-plane/plugins/git-repositories/optionalFeaturesFixture.js";

it("merges a zero-human-policy revision without recording approval and still requires promoter authority", { timeout: 30_000 }, async () => {
  // Given
  const promoter = { hostId: "host-a", username: "promoter", password: token(10) };
  const prepared = await Promise.all([pullRequests.configure({}), mergePolicy.configure({ hostPromoters: [promoter] })]);
  const f = await fixture(true, prepared.flatMap((plugin) => plugin.extensions ?? []),
    { requiredReviewerIds: [], pathReviewerRules: [{ pathPrefix: ".dim/", reviewerIds: ["owner"] }] }, [reviewer], { "merge-policy": {} });
  try {
    await writeFile(join(f.source, "README.md"), "No protected configuration changes\n");
    const candidate = await f.commit();
    await git("/usr/bin/git", ["-C", f.source, "push", "origin", "HEAD:refs/heads/feature/ordinary"]);
    const reviewerFile = join(f.root, "reviewer.json"), promoterFile = join(f.root, "promoter.json");
    await writeFile(reviewerFile, JSON.stringify({ schemaVersion: 1, serviceId: "native-main", baseUrl: f.origin, generationId, ...reviewer }), { mode: 0o600 });
    await writeFile(promoterFile, JSON.stringify({ schemaVersion: 1, serviceId: "native-main", endpoint: f.origin, generationId,
      role: "host-promoter", hostId: promoter.hostId, credential: { username: promoter.username, password: promoter.password } }), { mode: 0o600 });
    const projects = async () => [{ projectId: "project", name: "local-alias", repositoryIds: ["main"] }];
    const selected = await createNativeGitOperator({ reviewerConnection: reviewerFile, promoterConnection: promoterFile, projects });
    const scope = { projectId: "project", repositoryId: "main" };
    const pr = parsePullRequest(await selected.invoke("pull-requests.create", { ...scope, title: "Ordinary branch", sourceRef: "refs/heads/feature/ordinary" }));
    const input = { ...scope, pullRequestId: pr.id, expectedVersion: pr.version, revisionId: currentRevision(pr).id };
    let approvals = 0;
    f.service.server.on("request", (request) => { if (request.url?.endsWith("/approvals")) approvals += 1; });
    const withoutPromoter = await createNativeGitOperator({ reviewerConnection: reviewerFile, projects });
    expect(withoutPromoter.operations.some(({ name }) => name === "pull-requests.merge")).toBe(false);
    await expect(withoutPromoter.invoke("pull-requests.merge", input)).rejects.toThrow("unavailable");
    await expect(selected.invoke("pull-requests.merge", { ...input, revisionId: randomUUID() })).rejects.toThrow("revision changed");

    // When
    const merged = await selected.invoke("pull-requests.merge", input);

    // Then
    expect(merged).toMatchObject({ pullRequest: { state: "merged" }, review: { requiredReviewerIds: [], approvals: [], ci: { state: "not-configured" } }, refreshPending: false });
    expect(approvals).toBe(0);
    expect((await git("/usr/bin/git", ["--git-dir", join(f.root, "state/project/main.git"), "rev-parse", "refs/heads/main"])).stdout.trim()).toBe(candidate);
  } finally { await f.service.close(); await rm(f.root, { recursive: true, force: true }); }
});
