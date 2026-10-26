import { readAuthoritativeNativeCandidateFile } from "../../../../packages/control-plane/plugins/git-review/src/authoritative-native-review-git.js";
import { randomUUID } from "node:crypto";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { codeReviewPolicy } from "../../../../packages/control-plane/plugins/git-review/src/policy.js";
import { reviewChangeMatchers, reviewChangeMatcherExtension, type ReviewChangeMatcher, type CodeReviewService } from "@slop-lab/dim-control-plane-plugin-git-review/plugin-api";
import { nativeRepositoryPolicyRevision, type NativeImportedRootPolicy } from "@slop-lab/dim-contracts-git";
import { controlPlanePlugin as mergePlugin } from "@slop-lab/dim-control-plane-plugin-git-merge-policy";
import { basic, fixture, generationId, git, record, reviewer, text, token } from "../git-repositories/optionalFeaturesFixture.js";

const matcher: ReviewChangeMatcher = { name: "boundary", revision: "1".repeat(64), validate(options) { if (options !== "reviewed") throw new Error("invalid boundary options"); }, async matches({ changes, readBlob }) {
  for (const change of changes) if (change.newObjectId !== "0" && (await readBlob(change.newObjectId)).includes("boundary")) return true;
  return false;
} };
const reviewPolicy = { requiredReviewerIds: ["owner"], pathReviewerRules: [], changeReviewerRules: [{ matcher: matcher.name, options: "reviewed", reviewerIds: ["security"] }] };
function policy(review = reviewPolicy): NativeImportedRootPolicy {
  const extensions = { "code-review": review };
  return { schemaVersion: 1, protectedRef: "refs/heads/main", extensions, policyRevision: nativeRepositoryPolicyRevision({ protectedRef: "refs/heads/main", extensions }) };
}
it("rejects missing, duplicate, malformed and invalidly configured matchers and binds implementation revisions", () => {
  expect(() => codeReviewPolicy(policy())).toThrow(/unavailable/);
  expect(() => reviewChangeMatchers([reviewChangeMatcherExtension(matcher), reviewChangeMatcherExtension(matcher)])).toThrow(/duplicate/);
  expect(() => reviewChangeMatcherExtension({ ...matcher, revision: "unpinned" })).toThrow(/invalid/);
  expect(() => codeReviewPolicy(policy({ ...reviewPolicy, changeReviewerRules: [{ ...reviewPolicy.changeReviewerRules[0]!, options: "candidate" }] }), [matcher])).toThrow(/options/);
  expect(codeReviewPolicy(policy(), [matcher]).requiredReviewRevision).not.toBe(codeReviewPolicy(policy(), [{ ...matcher, revision: "2".repeat(64) }]).requiredReviewRevision);
});
it("applies configured review rules only to branches that enable review", () => {
  const base = policy();
  const branches = { "refs/heads/main": { review: true }, "refs/heads/development": { review: false } };
  const input = { ...base, defaultRef: "refs/heads/main", branches };
  const configured = { ...input, policyRevision: nativeRepositoryPolicyRevision(input) };
  expect(codeReviewPolicy(configured, [matcher], "refs/heads/main").requiredReviewerIds).toEqual(["owner"]);
  const development = codeReviewPolicy(configured, [matcher], "refs/heads/development");
  expect(development.requiredReviewerIds).toEqual([]);
  expect(development.pathReviewerRules).toEqual([]);
  expect(development.changeReviewerRules).toEqual([]);
  expect(() => codeReviewPolicy(configured, [matcher], "refs/heads/unmanaged")).toThrow(/not managed/);
});
it.each([true, false])("unions mandatory path guards with matcher result %s and rejects stale matcher merge approvals", async (matches) => {
  const promoter = { hostId: "host-a", username: "promoter", password: token(10) };
  const security = { reviewerId: "security", username: "security", password: token(11) };
  const merge = await mergePlugin.configure({ hostPromoters: [promoter] });
  const provider = { ...matcher, ...(matches ? {} : { async matches() { return false; } }) };
  const f = await fixture(true, [...(merge.extensions ?? []), reviewChangeMatcherExtension(provider)], { ...reviewPolicy, pathReviewerRules: matches ? [] : [{ pathPrefix: "README.md", reviewerIds: ["security"] }] }, [reviewer, security]);
  const headers = (credential: { username: string; password: string }) => ({ authorization: basic(credential), "content-type": "application/json", "x-dim-generation-id": generationId });
  try {
    await writeFile(join(f.source, "README.md"), "security boundary changed\n");
    const candidate = await f.commit();
    await git("/usr/bin/git", ["-C", f.source, "push", "origin", `HEAD:${f.proposalRef}`]);
    const resolved = await fetch(`${f.origin}/v1/projects/project/repositories/main/reviews/resolve`, { method: "POST", headers: headers(reviewer), body: JSON.stringify({ schemaVersion: 1, proposalRef: f.proposalRef }) });
    expect(resolved.status, await resolved.clone().text()).toBe(200);
    const review = record(record(await resolved.json()).review);
    expect(review.requiredReviewerIds).toEqual(["owner", "security"]);
    const path = `${f.origin}/v1/projects/project/repositories/main/reviews/${text(review, "reviewId")}`;
    const promote = () => fetch(`${path}/promotions`, { method: "POST", headers: headers(promoter), body: JSON.stringify({ schemaVersion: 1 }) });
    const approve = async (credential: typeof reviewer) => {
      const response = await fetch(`${path}/approvals`, { method: "POST", headers: headers(credential), body: JSON.stringify({ requestId: randomUUID() }) });
      expect(response.status, await response.clone().text()).toBe(201);
    };
    await approve(reviewer); expect((await promote()).status).toBe(409);
    await approve(security);
    const evaluate = provider.matches;
    provider.matches = async () => { throw new Error("matcher unavailable"); };
    expect((await promote()).status).toBe(409);
    provider.matches = async () => undefined as unknown as boolean;
    expect((await promote()).status).toBe(409);
    provider.matches = evaluate;
    provider.revision = "2".repeat(64);
    expect((await promote()).status).toBe(409);
    provider.revision = matcher.revision;
    expect((await promote()).status).toBe(201);
    expect((await git("/usr/bin/git", ["--git-dir", join(f.root, "state/project/main.git"), "rev-parse", "refs/heads/main"])).stdout.trim()).toBe(candidate);
  } finally { await f.service.close(); await rm(f.root, { recursive: true, force: true }); }
}, 30_000);

it("reads bounded exact candidate regular files and rejects traversal, links, directories and oversized objects", async () => {
  const f = await fixture(true);
  try {
    await mkdir(join(f.source, "rules"));
    await writeFile(join(f.source, "rules/literal[1].json"), '{"review":true}\n');
    await writeFile(join(f.source, "rules/oversized.json"), Buffer.alloc(1024 * 1024 + 1, 32));
    await symlink("literal[1].json", join(f.source, "rules/link.json"));
    await git("/usr/bin/git", ["-C", f.source, "add", "."]);
    const candidateCommit = await f.commit();
    const input = { gitExecutable: f.service.context.runtime.gitExecutable, gitIdentity: f.service.context.runtime.gitIdentity,
      repository: join(f.source, ".git"), candidateCommit, signal: AbortSignal.timeout(30_000) };
    expect((await readAuthoritativeNativeCandidateFile(input, "README.md"))?.toString()).toBe("initial\n");
    expect((await readAuthoritativeNativeCandidateFile(input, "rules/literal[1].json"))?.toString()).toBe('{"review":true}\n');
    expect(await readAuthoritativeNativeCandidateFile(input, "rules/absent.json")).toBeUndefined();
    for (const path of ["../README.md", "/README.md", "rules/../README.md", "rules//x", "rules/", "", "rules\\x"])
      await expect(readAuthoritativeNativeCandidateFile(input, path)).rejects.toThrow(/normalized relative/);
    await expect(readAuthoritativeNativeCandidateFile(input, "rules/link.json")).rejects.toThrow(/regular file/);
    await expect(readAuthoritativeNativeCandidateFile(input, "rules")).rejects.toThrow(/regular file/);
    await expect(readAuthoritativeNativeCandidateFile(input, "rules/oversized.json")).rejects.toThrow(/1 MiB/);
    await writeFile(join(f.source, "README.md"), "mutable working tree is not a matcher input\n");
    expect((await readAuthoritativeNativeCandidateFile(input, "README.md"))?.toString()).toBe("initial\n");
  } finally { await f.service.close(); await rm(f.root, { recursive: true, force: true }); }
}, 30_000);

it("allows conditional-only review: ordinary changes promote directly while sensitive changes require security approval", async () => {
  const promoter = { hostId: "host-a", username: "promoter", password: token(10) };
  const security = { reviewerId: "security", username: "security", password: token(11) };
  const merge = await mergePlugin.configure({ hostPromoters: [promoter] });
  const f = await fixture(true, [...(merge.extensions ?? []), reviewChangeMatcherExtension(matcher)], { ...reviewPolicy, requiredReviewerIds: [] }, [security]);
  const headers = (credential: { username: string; password: string }) => ({ authorization: basic(credential), "content-type": "application/json", "x-dim-generation-id": generationId });
  try {
    const extension = f.service.context.extensions.find(({ kind, name }) => kind === "dim.code-review.service" && name === "default");
    if (extension === undefined) throw new Error("review service is missing");
    const reviews = extension.value as CodeReviewService;
    const propose = async (contents: string) => {
      await writeFile(join(f.source, "README.md"), contents); await f.commit();
      await git("/usr/bin/git", ["-C", f.source, "push", "origin", `HEAD:${f.proposalRef}`]);
      return reviews.create(f.service.context, { projectId: "project", repositoryId: "main", proposalRef: f.proposalRef });
    };
    const path = (reviewId: string) => `${f.origin}/v1/projects/project/repositories/main/reviews/${reviewId}`;
    const promote = (reviewId: string) => fetch(`${path(reviewId)}/promotions`, { method: "POST", headers: headers(promoter), body: JSON.stringify({ schemaVersion: 1 }) });
    const ordinary = await propose("ordinary documentation change\n");
    expect(ordinary.review.requiredReviewerIds).toEqual([]);
    expect((await promote(ordinary.review.reviewId)).status).toBe(201);
    const sensitive = await propose("security boundary changed\n");
    expect(sensitive.review.requiredReviewerIds).toEqual(["security"]);
    expect((await promote(sensitive.review.reviewId)).status).toBe(409);
    const approval = await fetch(`${path(sensitive.review.reviewId)}/approvals`, { method: "POST", headers: headers(security), body: JSON.stringify({ requestId: randomUUID() }) });
    expect(approval.status, await approval.clone().text()).toBe(201);
    expect((await promote(sensitive.review.reviewId)).status).toBe(201);
  } finally { await f.service.close(); await rm(f.root, { recursive: true, force: true }); }
}, 30_000);

it("binds structured matcher evidence even when the required reviewer set stays unchanged", async () => {
  const promoter = { hostId: "host-a", username: "promoter", password: token(10) };
  const merge = await mergePlugin.configure({ hostPromoters: [promoter] });
  let digest = "a".repeat(64);
  const provider: ReviewChangeMatcher = { name: "observed", revision: "3".repeat(64), validate() {}, async matches({ readBaseFile, readCandidateFile }) {
    expect(await readBaseFile?.("README.md")).toEqual(Buffer.from("initial\n"));
    expect(await readCandidateFile("README.md")).toEqual(Buffer.from("candidate\n"));
    return { matches: false, evidenceDigest: digest };
  } };
  const f = await fixture(true, [...(merge.extensions ?? []), reviewChangeMatcherExtension(provider)], { requiredReviewerIds: [], pathReviewerRules: [], changeReviewerRules: [{ matcher: "observed", options: {}, reviewerIds: ["owner"] }] }, [reviewer]);
  try {
    await writeFile(join(f.source, "README.md"), "candidate\n"); await f.commit();
    await git("/usr/bin/git", ["-C", f.source, "push", "origin", `HEAD:${f.proposalRef}`]);
    const extension = f.service.context.extensions.find(({ kind, name }) => kind === "dim.code-review.service" && name === "default");
    const service = extension!.value as CodeReviewService;
    const envelope = await service.create(f.service.context, { projectId: "project", repositoryId: "main", proposalRef: f.proposalRef });
    expect(envelope.review.changeRuleEvidence).toEqual([{ rule: 0, digest }]);
    const promote = () => fetch(`${f.origin}/v1/projects/project/repositories/main/reviews/${envelope.review.reviewId}/promotions`, { method: "POST", headers: { authorization: basic(promoter), "content-type": "application/json", "x-dim-generation-id": generationId }, body: JSON.stringify({ schemaVersion: 1 }) });
    digest = "b".repeat(64);
    expect((await promote()).status).toBe(409);
    const newEnvelope = await service.create(f.service.context, { projectId: "project", repositoryId: "main", proposalRef: f.proposalRef });
    expect(newEnvelope.review.requiredReviewerIds).toEqual(envelope.review.requiredReviewerIds);
    expect(newEnvelope.review.reviewId).not.toBe(envelope.review.reviewId);
    digest = "a".repeat(64);
    expect((await promote()).status).toBe(201);
  } finally { await f.service.close(); await rm(f.root, { recursive: true, force: true }); }
}, 30_000);

it("allows review-disabled branches without an extension and fails closed with actionable missing or malformed policy", () => {
  const input = { protectedRef: "refs/heads/main", branches: { "refs/heads/main": { review: true }, "refs/heads/development": { review: false } }, extensions: {} };
  const missing = { schemaVersion: 1 as const, ...input, policyRevision: nativeRepositoryPolicyRevision(input) };
  expect(codeReviewPolicy(missing, [], "refs/heads/development").requiredReviewerIds).toEqual([]);
  expect(() => codeReviewPolicy(missing, [], "refs/heads/main")).toThrow(/missing.*policy.code-review/);
  expect(() => codeReviewPolicy(missing)).toThrow(/missing/);
  const malformed = { ...missing, extensions: { "code-review": { requiredReviewerIds: "owner" } } };
  expect(() => codeReviewPolicy(malformed, [], "refs/heads/main")).toThrow(/invalid.*policy.code-review/);
  expect(() => codeReviewPolicy(malformed, [], "refs/heads/development")).toThrow(/invalid/);
});
