import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { controlPlanePlugin, parseGitSyncPolicy } from "../../../../packages/control-plane/plugins/git-sync/src/index.js";
import { readAuthoritativeNativeReviewEnvelopes } from "@slop-lab/dim-control-plane-plugin-code-review/plugin-api";
import { controlPlanePlugin as mergePlugin } from "@slop-lab/dim-control-plane-plugin-merge-policy";
import { basic, fixture, git, generationId, record, reviewer, text, token } from "../git-repositories/optionalFeaturesFixture.js";
const operator = { hostId: "host-a", username: "synchronizer", password: token(20) };
const foreign = { hostId: "host-b", username: "foreign-synchronizer", password: token(21) };
const promoter = { hostId: "host-a", username: "promoter", password: token(22) };
const headers = (credential: { username: string; password: string } = operator) => ({ authorization: basic(credential), "content-type": "application/json", "x-dim-generation-id": generationId });

async function synchronizedFixture() {
  const directory = await mkdtemp(join(tmpdir(), "dim-git-sync-upstream-"));
  const upstream = join(directory, "upstream.git");
  try {
    await git("/usr/bin/git", ["init", "--bare", upstream]);
    const sync = await controlPlanePlugin.configure({ operators: [operator, foreign], allowLocalRemotes: true });
    const merge = await mergePlugin.configure({ hostPromoters: [promoter] });
    const f = await fixture(true, [...(sync.extensions ?? []), ...(merge.extensions ?? [])],
      { requiredReviewerIds: [], pathReviewerRules: [{ pathPrefix: ".dim/", reviewerIds: ["owner"] }] }, [reviewer],
      { "git-sync": { upstream: { url: pathToFileURL(upstream).href, branch: "development" }, publish: { main: "development" } }, "merge-policy": {} });
    try {
      await git("/usr/bin/git", ["-C", f.source, "push", upstream, "HEAD:refs/heads/development"]);
      const checkout = join(directory, "external");
      await git("/usr/bin/git", ["clone", "-b", "development", upstream, checkout]);
      const externalCommit = async (path: string, contents: string) => {
        await mkdir(join(checkout, path, ".."), { recursive: true }); await writeFile(join(checkout, path), contents);
        await git("/usr/bin/git", ["-C", checkout, "add", "."]);
        await git("/usr/bin/git", ["-C", checkout, "-c", "user.name=External", "-c", "user.email=external@example.invalid", "commit", "-m", "external change"]);
        await git("/usr/bin/git", ["-C", checkout, "push", "origin", "development"]);
        return (await git("/usr/bin/git", ["-C", checkout, "rev-parse", "HEAD"])).stdout.trim();
      };
      const base = `${f.origin}/v1/projects/project/repositories/main`;
      const operation = (name: string, credential = operator, generation = generationId, body: unknown = { schemaVersion: 1 }) => fetch(`${base}/sync/${name}`, {
        method: "POST", headers: { ...headers(credential), "x-dim-generation-id": generation }, body: JSON.stringify(body) });
      const head = async (ref = "refs/heads/main") => (await git("/usr/bin/git", ["--git-dir", join(f.root, "state/project/main.git"), "rev-parse", "--verify", ref])).stdout.trim();
      const upstreamHead = async () => (await git("/usr/bin/git", ["--git-dir", upstream, "rev-parse", "refs/heads/development"])).stdout.trim();
      const resolveReview = async (proposalRef: string) => {
        const envelope = (await readAuthoritativeNativeReviewEnvelopes(join(f.root, "state/project/main.git")))
          .find(({ review }) => review.proposalRef === proposalRef);
        if (!envelope) throw new Error("proposal reconciliation did not create a review");
        return record(envelope.review);
      };
      const promote = async (reviewId: string) => {
        const response = await fetch(`${base}/reviews/${reviewId}/promotions`, { method: "POST", headers: headers(promoter), body: JSON.stringify({ schemaVersion: 1 }) });
        return response;
      };
      const close = async () => { await f.service.close(); await rm(f.root, { recursive: true, force: true }); await rm(directory, { recursive: true, force: true }); };
      return { ...f, directory, upstream, checkout, operation, head, upstreamHead, externalCommit, resolveReview, promote, base, close };
    } catch (error) { await f.service.close(); await rm(f.root, { recursive: true, force: true }); throw error; }
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
}

it("fetches upstream, promotes ordinary changes without human approval, and publishes only authoritative main to development", async () => {
  const f = await synchronizedFixture();
  try {
    const external = await f.externalCommit("feature.txt", "upstream change\n");
    const fetched = await f.operation("fetch"); expect(fetched.status, await fetched.clone().text()).toBe(200);
    expect(record(await fetched.json())).toMatchObject({ outcome: "fetched", upstreamCommit: external, upstreamRef: "refs/remotes/upstream/development" });
    expect(await f.head()).toBe(f.initial);
    await git("/usr/bin/git", ["-C", f.source, "fetch", "origin", "refs/remotes/upstream/development:refs/remotes/upstream/development"]);
    expect((await git("/usr/bin/git", ["-C", f.source, "rev-parse", "upstream/development"])).stdout.trim()).toBe(external);
    await expect(git("/usr/bin/git", ["-C", f.source, "push", "origin", "HEAD:refs/remotes/upstream/development"])).rejects.toThrow();
    expect(await f.head("refs/remotes/upstream/development")).toBe(external);
    const synced = await f.operation("merge"); expect(synced.status, await synced.clone().text()).toBe(200);
    const proposed = record(await synced.json()); expect(proposed).toMatchObject({ outcome: "proposed", candidateCommit: external });
    expect(await f.head()).toBe(f.initial);
    expect(record(await (await f.operation("merge")).json())).toMatchObject({ outcome: "proposed", proposalRef: proposed.proposalRef, candidateCommit: external });
    expect(await f.operation("publish").then((response) => response.status)).toBe(409); // authoritative main is behind remote
    const review = await f.resolveReview(text(proposed, "proposalRef")); expect(review.requiredReviewerIds).toEqual([]);
    expect((await f.promote(text(review, "reviewId"))).status).toBe(201); expect(await f.head()).toBe(external);
    expect(record(await (await f.operation("merge")).json()).outcome).toBe("unchanged");
    // A local proposal has never been published merely because it exists.
    await writeFile(join(f.source, "local.txt"), "managed work\n"); await git("/usr/bin/git", ["-C", f.source, "add", "."]);
    await git("/usr/bin/git", ["-C", f.source, "fetch", f.upstream, "development"]);
    await git("/usr/bin/git", ["-C", f.source, "merge", "--ff-only", external]);
    const local = await f.commit(); await git("/usr/bin/git", ["-C", f.source, "push", "origin", `HEAD:${f.proposalRef}`]);
    const localReview = await f.resolveReview(f.proposalRef); expect((await f.promote(text(localReview, "reviewId"))).status).toBe(201);
    expect(await f.upstreamHead()).toBe(external);
    const published = await f.operation("publish"); expect(published.status, await published.clone().text()).toBe(200);
    expect(record(await published.json())).toEqual({ schemaVersion: 1, outcome: "published", sourceCommit: local, targetRef: "refs/heads/development" });
    expect(await f.upstreamHead()).toBe(local);
  } finally { await f.close(); }
}, 30_000);

it("creates merge proposals for divergence and requires review before importing changes under .dim", async () => {
  const f = await synchronizedFixture();
  try {
    await writeFile(join(f.source, "local.txt"), "local development\n"); await git("/usr/bin/git", ["-C", f.source, "add", "."]);
    const local = await f.commit(); await git("/usr/bin/git", ["-C", f.source, "push", "origin", `HEAD:${f.proposalRef}`]);
    const localReview = await f.resolveReview(f.proposalRef); expect((await f.promote(text(localReview, "reviewId"))).status).toBe(201);
    const external = await f.externalCommit(".dim/boundary.json", '{"secrets":"secure"}\n');
    const synced = await f.operation("merge"); expect(synced.status, await synced.clone().text()).toBe(200);
    const proposed = record(await synced.json()); expect(proposed.outcome).toBe("proposed");
    const candidate = text(proposed, "candidateCommit"); expect(candidate).not.toBe(external);
    const parents = (await git("/usr/bin/git", ["--git-dir", join(f.root, "state/project/main.git"), "show", "-s", "--format=%P", candidate])).stdout.trim();
    expect(parents).toBe(`${local} ${external}`);
    expect(await f.head()).toBe(local);
    const review = await f.resolveReview(text(proposed, "proposalRef")); expect(review.requiredReviewerIds).toEqual(["owner"]);
    expect((await f.promote(text(review, "reviewId"))).status).toBe(409); expect(await f.head()).toBe(local);
    const approved = await fetch(`${f.base}/reviews/${text(review, "reviewId")}/approvals`, { method: "POST", headers: headers(reviewer), body: JSON.stringify({ requestId: randomUUID() }) });
    expect(approved.status, await approved.clone().text()).toBe(201);
    expect((await f.promote(text(review, "reviewId"))).status).toBe(201); expect(await f.head()).toBe(candidate);
    const again = record(await (await f.operation("publish")).json()); expect(again.sourceCommit).toBe(candidate); expect(await f.upstreamHead()).toBe(candidate);
  } finally { await f.close(); }
}, 30_000);

it("leaves main unchanged on merge conflicts, rejects rewrites, and enforces host, role, generation and body boundaries", async () => {
  const f = await synchronizedFixture();
  try {
    const identity = await fetch(`${f.origin}/v1/git-sync-operator-identity`, { headers: headers() });
    expect(record(await identity.json())).toMatchObject({ role: "git-sync-operator", hostId: "host-a", generationId });
    expect((await f.operation("fetch", foreign)).status).toBe(404);
    expect((await fetch(`${f.base}/sync/fetch`, { method: "POST", headers: headers(reviewer), body: '{"schemaVersion":1}' })).status).toBe(403);
    expect((await f.operation("fetch", operator, "b".repeat(64))).status).toBe(409);
    expect((await f.operation("publish", operator, generationId, { schemaVersion: 1, commit: f.initial })).status).toBe(400);
    await writeFile(join(f.source, "README.md"), "managed edit\n"); const local = await f.commit();
    await git("/usr/bin/git", ["-C", f.source, "push", "origin", `HEAD:${f.proposalRef}`]);
    const review = await f.resolveReview(f.proposalRef); expect((await f.promote(text(review, "reviewId"))).status).toBe(201);
    const external = await f.externalCommit("README.md", "upstream edit\n");
    const conflict = await f.operation("merge"); expect(conflict.status).toBe(200);
    expect(record(await conflict.json())).toMatchObject({ outcome: "conflict", upstreamCommit: external, expectedProtectedHead: local });
    expect(await f.head()).toBe(local); expect((await f.operation("publish")).status).toBe(409);
    await git("/usr/bin/git", ["--git-dir", f.upstream, "update-ref", "refs/heads/development", f.initial]);
    expect((await f.operation("fetch")).status).toBe(409); expect(await f.head("refs/remotes/upstream/development")).toBe(external);
    expect((await git("/usr/bin/git", ["--git-dir", join(f.root, "state/project/main.git"), "for-each-ref", "refs/remotes/upstream/dim-fetch-"])).stdout).toBe("");
  } finally { await f.close(); }
}, 30_000);

it("rejects ambiguous branches and credential-bearing or untrusted remote transports", () => {
  const policy = (url = "https://github.com/example/project.git", branch = "development") => ({ upstream: { url, branch }, publish: { main: "development" } });
  expect(() => parseGitSyncPolicy(policy(), false)).not.toThrow();
  for (const branch of ["-x", "development:main", "refs/heads/main", "main~1", "../main", "a//b", "a.lock", "a/.hidden", "a\\b"]) expect(() => parseGitSyncPolicy(policy(undefined, branch), false)).toThrow();
  for (const url of ["file:///tmp/project.git", "ssh://git@example.com/repo", "https://token@github.com/a/b", "https://github.com/a/b?token=x"]) expect(() => parseGitSyncPolicy(policy(url), false)).toThrow();
  expect(() => parseGitSyncPolicy(policy("file:///tmp/project.git"), true)).not.toThrow();
});
