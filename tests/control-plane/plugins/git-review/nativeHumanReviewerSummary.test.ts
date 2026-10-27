import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { reviewChangeMatcherExtension, parseAuthoritativeNativeReviewEnvelope } from "@slop-lab/dim-control-plane-plugin-git-review/plugin-api";
import * as reviewGit from "../../../../packages/control-plane/plugins/git-review/src/authoritative-native-review-git.js";
import { basic, fixture, generationId, git, record, reviewer } from "../git-repositories/optionalFeaturesFixture.js";

it("lists immutable review evidence by its mutable tuple without rebuilding patches or executing project matchers", async () => {
  let revision = "a".repeat(64), matcherCalls = 0;
  const matcher = reviewChangeMatcherExtension({ name: "project-check", get revision() { return revision; }, validate() {},
    async matches() { matcherCalls++; return true; } });
  const f = await fixture(true, [matcher], { requiredReviewerIds: [], pathReviewerRules: [], changeReviewerRules: [{ matcher: "project-check", options: {}, reviewerIds: ["owner"] }] });
  const path = `${f.origin}/v1/projects/project/repositories/main/reviews`, headers = { authorization: basic(reviewer), "x-dim-generation-id": generationId, "content-type": "application/json" };
  const list = async () => { const response = await fetch(path, { headers }); expect(response.status).toBe(200); const result: unknown = await response.json(); if (!Array.isArray(result)) throw new Error("missing review summaries"); return result.map(record); };
  try {
    await writeFile(join(f.source, "README.md"), "candidate one\n"); await f.commit();
    await git("/usr/bin/git", ["-C", f.source, "push", "origin", `HEAD:${f.proposalRef}`]);
    const resolved = await fetch(path + "/resolve", { method: "POST", headers, body: JSON.stringify({ schemaVersion: 1, proposalRef: f.proposalRef }) });
    expect(resolved.status).toBe(200);
    const envelope = parseAuthoritativeNativeReviewEnvelope(await resolved.json());
    const before = matcherCalls, inspections = vi.spyOn(reviewGit, "inspectAuthoritativeNativeReviewGit");
    expect((await list()).find(({ reviewId }) => reviewId === envelope.review.reviewId)?.status).toBe("pending");
    expect(matcherCalls).toBe(before); expect(inspections).not.toHaveBeenCalled();
    const exact = await fetch(`${path}/${envelope.review.reviewId}`, { headers });
    expect(exact.status).toBe(200); expect(record(await exact.json()).status).toBe("pending");
    expect(matcherCalls).toBeGreaterThan(before); expect(inspections).toHaveBeenCalled(); inspections.mockClear();
    revision = "b".repeat(64);
    const beforeChangedProvider = matcherCalls;
    expect((await list()).find(({ reviewId }) => reviewId === envelope.review.reviewId)?.status).toBe("stale");
    expect(matcherCalls).toBe(beforeChangedProvider); expect(inspections).not.toHaveBeenCalled();
    const approval = await fetch(`${path}/${envelope.review.reviewId}/approvals`, { method: "POST", headers, body: JSON.stringify({ requestId: "12345678-1234-4234-8234-123456789012" }) });
    expect(approval.status).toBe(409);
    revision = "a".repeat(64);
    await writeFile(join(f.source, "README.md"), "candidate two\n"); await f.commit();
    await git("/usr/bin/git", ["-C", f.source, "push", "origin", `HEAD:${f.proposalRef}`]);
    const current = (await git("/usr/bin/git", ["-C", f.source, "rev-parse", "HEAD"])).stdout.trim();
    await expect.poll(async () => {
      const response = await fetch(`${f.origin}/v1/projects/project/repositories/main/review-preparations`, { headers });
      const value: unknown = await response.json();
      if (typeof value !== "object" || value === null || !("jobs" in value) || !Array.isArray(value.jobs)) return undefined;
      const job = value.jobs.find((candidate) => typeof candidate === "object" && candidate !== null
        && Reflect.get(candidate, "candidateCommit") === current);
      return job === undefined ? undefined : Reflect.get(job, "status");
    }).toBe("ready");
    inspections.mockClear(); const refs = vi.spyOn(reviewGit, "readAuthoritativeNativeReviewRefs"), beforeDrift = matcherCalls;
    expect((await list()).find(({ reviewId }) => reviewId === envelope.review.reviewId)?.status).toBe("stale");
    expect(refs).toHaveBeenCalledTimes(1); expect(matcherCalls).toBe(beforeDrift); expect(inspections).not.toHaveBeenCalled();
  } finally { vi.restoreAllMocks(); await f.service.close(); await rm(f.root, { recursive: true, force: true }); }
});
