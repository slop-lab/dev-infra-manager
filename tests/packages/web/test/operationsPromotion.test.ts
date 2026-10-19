import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { nativeBundleReviewFixture, createBundleReview } from "../../native-git/test/nativeBundleReviewFixture.js";
import { authoritativePolicy } from "../../native-git/test/authoritativeNativeCandidateFixture.js";
import { hostPromoter, rootRepository, runGit } from "../../native-git/test/nativeRootImportFinalizeFixture.js";
import { createReviewerWebServerFromConfigFile } from "../../../../packages/web/src/server.js";
import { parseReviewerWebConfig } from "../../../../packages/web/src/config.js";
import { availablePort, WEB_PASSWORD, webConfig } from "./webHarness.js";
it("discovers authoritative proposals and separates reviewer decisions from operator protected-ref promotion", async () => {
  const native = await nativeBundleReviewFixture("web-operations-promotion", undefined, authoritativePolicy(["owner"], [], []));
  const root = await mkdtemp(join(tmpdir(), "dim-web-promote-"));
  const envelope = await createBundleReview(native.service), port = await availablePort(), origin = `http://127.0.0.1:${port}`;
  const base = parseReviewerWebConfig(webConfig({ accounts: ["reviewer", "operator", "reader"], reviewerAccountId: "reviewer", nativeBaseUrl: native.service.origin, publicOrigin: origin, port }));
  if (!base.nativeGit) throw new Error("missing test native configuration");
  const config = { ...base, nativeGit: { ...base.nativeGit, promoter: hostPromoter },
    accounts: base.accounts.map((account) => account.username === "operator" ? { ...account, roles: ["read", "operator"] } : account) };
  const file = join(root, "web.json"); await writeFile(file, JSON.stringify(config), { mode: 0o600 });
  const web = await createReviewerWebServerFromConfigFile(file);
  const head = async () => (await runGit("/usr/bin/git", ["--git-dir", rootRepository(native.root), "rev-parse", "refs/heads/main"])).stdout.trim();
  try {
    await web.listen();
    const login = async (username: string) => {
      const response = await fetch(origin + "/v1/session", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ username, password: WEB_PASSWORD }) });
      const body = await response.json() as { csrfToken: string };
      return { cookie: response.headers.get("set-cookie")!.split(";")[0]!, origin, "content-type": "application/json", "x-dim-csrf": body.csrfToken };
    };
    const reviewer = await login("reviewer"), operator = await login("operator"), reader = await login("reader");
    const collection = "/v1/projects/project-a/repositories/root/reviews", path = `${collection}/${envelope.review.reviewId}`;
    const listing = await fetch(origin + collection, { headers: reader }); expect(listing.status).toBe(200);
    expect(await listing.json()).toEqual([expect.objectContaining({ reviewId: envelope.review.reviewId, proposalRef: envelope.review.proposalRef })]);
    const before = await head();
    const mutate = (action: string, headers: typeof reader) => fetch(origin + path + "/" + action, { method: "POST", headers, body: "{}" });
    expect((await mutate("promotions", reader)).status).toBe(403);
    expect((await mutate("promotions", reviewer)).status).toBe(403);
    expect((await mutate("approvals", operator)).status).toBe(403);
    expect((await mutate("promotions", operator)).status).toBe(409); expect(await head()).toBe(before);
    expect((await mutate("approvals", reviewer)).status).toBe(200);
    const promoted = await mutate("promotions", operator); expect(promoted.status).toBe(200);
    expect(await promoted.json()).toMatchObject({ outcome: "promoted", candidateCommit: envelope.review.candidateCommit });
    expect(await head()).toBe(envelope.review.candidateCommit); expect(await head()).not.toBe(before);
  } finally { await web.close(); await native.service.close(); await Promise.all([root, native.root, native.clone].map((path) => rm(path, { recursive: true, force: true }))); }
});
