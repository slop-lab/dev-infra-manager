import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { authoritativePolicy } from "./authoritativeNativeCandidateFixture.js";
import {
  cleanupFinalizeFixtures,
  closeFinalizeService,
  startFinalizeService,
  activateFinalizeService,
  authorization,
  generationId,
  hostPromoterAuthorization,
  foreignHostPromoterAuthorization,
  humanReviewerAuthorization,
  hostPromoter,
  humanReviewer,
  rootRepository,
  runGit
} from "./nativeRootImportFinalizeFixture.js";
import {
  addCandidateCommit,
  nativeBundleReviewFixture,
  reviewProposalRef
} from "./nativeBundleReviewFixture.js";
import { bundleSecrets } from "./bundleConfigFixture.js";

afterEach(cleanupFinalizeFixtures);
const execute = promisify(execFile);

describe("installed native protected promotion", () => {
  it("creates, approves, and promotes an exact no-CI review through installed HTTP", async () => {
    // Given
    const fixture = await nativeBundleReviewFixture("installed-promotion", undefined,
      authoritativePolicy(["owner"], [], []));
    const created = await post(fixture.service.origin,
      "/v1/projects/project-a/repositories/root/reviews/resolve", humanReviewerAuthorization,
      { schemaVersion: 1, proposalRef: reviewProposalRef });
    expect(created.response.status).toBe(200);
    const reviewId = field(created.body, "review").reviewId;
    expect(typeof reviewId).toBe("string");
    const approved = await post(fixture.service.origin,
      `/v1/projects/project-a/repositories/root/reviews/${reviewId}/approvals`, humanReviewerAuthorization,
      { requestId: randomUUID() });
    expect(approved.response.status).toBe(201);
    const before = await protectedHead(fixture.root);

    // When
    const promoted = await post(fixture.service.origin,
      `/v1/projects/project-a/repositories/root/reviews/${reviewId}/promotions`, hostPromoterAuthorization,
      { schemaVersion: 1 });

    // Then
    expect(promoted.response.status, JSON.stringify(promoted.body)).toBe(201);
    expect(await protectedHead(fixture.root)).not.toBe(before);
    const proofResponse = await fetch(`${fixture.service.origin}/v1/projects/project-a/repositories/root/import/proof`, {
      method: "POST", headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({ schemaVersion: 1, generationId })
    });
    expect(proofResponse.status).toBe(200);
    expect(field(await proofResponse.json(), "currentHead")).toMatchObject({ sequence: 1,
      commit: field(created.body, "review").candidateCommit });
    const database = new DatabaseSync(`${fixture.root}/native-idle.sqlite3`, { readOnly: true });
    try {
      expect(database.prepare("SELECT COUNT(*) AS count FROM native_project_root_promotion_intent").get()?.count).toBe(0);
      expect(database.prepare("SELECT COUNT(*) AS count FROM native_project_root_promotion_finalized").get()?.count).toBe(1);
    } finally { database.close(); }
  });

  it("rejects obsolete promoter review creation and resolves without mutating the current envelope", async () => {
    // Given
    const fixture = await nativeBundleReviewFixture("installed-review-resolve", undefined,
      authoritativePolicy(["owner"], [], []));

    // When
    const rejected = await post(fixture.service.origin,
      "/v1/projects/project-a/repositories/root/reviews", hostPromoterAuthorization,
      { schemaVersion: 1, proposalRef: reviewProposalRef });
    const resolved = await post(fixture.service.origin,
      "/v1/projects/project-a/repositories/root/reviews/resolve", humanReviewerAuthorization,
      { schemaVersion: 1, proposalRef: reviewProposalRef });

    // Then
    expect(rejected.response.status).toBe(404);
    expect(resolved.response.status).toBe(200);
    expect(field(resolved.body, "review").proposalRef).toBe(reviewProposalRef);
  });

  it("rejects reviewer promotion and promoter approval without moving the ref", async () => {
    // Given
    const fixture = await nativeBundleReviewFixture("installed-promotion-roles", undefined,
      authoritativePolicy(["owner"], [], []));
    const created = await post(fixture.service.origin,
      "/v1/projects/project-a/repositories/root/reviews/resolve", humanReviewerAuthorization,
      { schemaVersion: 1, proposalRef: reviewProposalRef });
    const reviewId = field(created.body, "review").reviewId;
    const before = await protectedHead(fixture.root);

    // When
    const [reviewerPromotion, promoterApproval] = await Promise.all([
      post(fixture.service.origin,
        `/v1/projects/project-a/repositories/root/reviews/${reviewId}/promotions`, humanReviewerAuthorization,
        { schemaVersion: 1 }),
      post(fixture.service.origin,
        `/v1/projects/project-a/repositories/root/reviews/${reviewId}/approvals`, hostPromoterAuthorization,
        { requestId: randomUUID() })
    ]);

    // Then
    expect(reviewerPromotion.response.status).toBe(403);
    expect(promoterApproval.response.status).toBe(403);
    expect(await protectedHead(fixture.root)).toBe(before);
  });

  it("rejects stale, foreign-host, and CI credentials while preserving the protected ref", async () => {
    // Given
    const fixture = await nativeBundleReviewFixture("installed-promotion-denials", undefined,
      authoritativePolicy(["owner"], [], []));
    const created = await post(fixture.service.origin,
      "/v1/projects/project-a/repositories/root/reviews/resolve", humanReviewerAuthorization,
      { schemaVersion: 1, proposalRef: reviewProposalRef });
    const reviewId = field(created.body, "review").reviewId;
    if (typeof reviewId !== "string") throw new TypeError("review ID is missing");
    await post(fixture.service.origin,
      `/v1/projects/project-a/repositories/root/reviews/${reviewId}/approvals`, humanReviewerAuthorization,
      { requestId: randomUUID() });
    await addCandidateCommit(fixture.clone, "later.txt", Buffer.from("later\n"));
    await runGit("/usr/bin/git", ["-C", fixture.clone, "push", "origin", `HEAD:${reviewProposalRef}`]);
    const before = await protectedHead(fixture.root);
    const ciAuthorization = `Basic ${Buffer.from(`ci-results:${bundleSecrets.resultReporter}`).toString("base64")}`;

    // When
    const outcomes = await Promise.all([
      post(fixture.service.origin,
        `/v1/projects/project-a/repositories/root/reviews/${reviewId}/promotions`, hostPromoterAuthorization,
        { schemaVersion: 1 }),
      post(fixture.service.origin,
        "/v1/projects/project-a/repositories/root/reviews", foreignHostPromoterAuthorization,
        { schemaVersion: 1, proposalRef: reviewProposalRef }),
      post(fixture.service.origin,
        `/v1/projects/project-a/repositories/root/reviews/${reviewId}/promotions`, ciAuthorization,
        { schemaVersion: 1 })
    ]);

    // Then
    expect(outcomes.map(({ response }) => response.status)).toEqual([409, 404, 403]);
    expect(await protectedHead(fixture.root)).toBe(before);
  });

  it("serializes concurrent installed promotion requests into one durable transition", async () => {
    // Given
    const fixture = await nativeBundleReviewFixture("installed-promotion-concurrent", undefined,
      authoritativePolicy(["owner"], [], []));
    const created = await post(fixture.service.origin,
      "/v1/projects/project-a/repositories/root/reviews/resolve", humanReviewerAuthorization,
      { schemaVersion: 1, proposalRef: reviewProposalRef });
    const reviewId = field(created.body, "review").reviewId;
    if (typeof reviewId !== "string") throw new TypeError("review ID is missing");
    await post(fixture.service.origin,
      `/v1/projects/project-a/repositories/root/reviews/${reviewId}/approvals`, humanReviewerAuthorization,
      { requestId: randomUUID() });

    // When
    const responses = await Promise.all([1, 2].map(() => post(fixture.service.origin,
      `/v1/projects/project-a/repositories/root/reviews/${reviewId}/promotions`, hostPromoterAuthorization,
      { schemaVersion: 1 })));

    // Then
    expect(responses.map(({ response }) => response.status).sort()).toEqual([200, 201]);
    expect(responses.map(({ body }) => stringField(body, "outcome")).sort())
      .toEqual(["already-current", "promoted"]);
    const database = new DatabaseSync(join(fixture.root, "native-idle.sqlite3"), { readOnly: true });
    expect(database.prepare("SELECT COUNT(*) AS count FROM native_project_root_promotion_intent").get()?.count).toBe(0);
    expect(database.prepare("SELECT COUNT(*) AS count FROM native_project_root_promotion_finalized").get()?.count).toBe(1);
    database.close();
  });

  it("drives review and promotion through mode-0600 role connection files without exposing credentials", { timeout: 15_000 }, async () => {
    // Given
    const fixture = await nativeBundleReviewFixture("installed-promotion-cli", undefined,
      authoritativePolicy(["owner"], [], []));
    const promoterPath = join(fixture.root, "promoter.json");
    const reviewerPath = join(fixture.root, "reviewer.json");
    await Promise.all([
      connectionFile(promoterPath, fixture.service.origin, "host-promoter", hostPromoter),
      connectionFile(reviewerPath, fixture.service.origin, "human-reviewer", humanReviewer)
    ]);

    // When
    const created = await cli(["resolve", reviewerPath, "project-a", "root", reviewProposalRef]);
    const reviewId = field(JSON.parse(created), "review").reviewId;
    if (typeof reviewId !== "string") throw new TypeError("review ID is missing");
    await cli(["inspect", reviewerPath, "project-a", "root", reviewId]);
    const approved = await cli(["approve", reviewerPath, "project-a", "root", reviewId]);
    const promoted = await cli(["promote", promoterPath, "project-a", "root", reviewId]);

    // Then
    expect(JSON.parse(approved)).toMatchObject({ reviewerId: "owner", status: "approved" });
    expect(JSON.parse(promoted)).toMatchObject({ outcome: "promoted", reviewId });
    expect(`${created}${approved}${promoted}`).not.toContain(hostPromoter.password);
    expect(`${created}${approved}${promoted}`).not.toContain(humanReviewer.password);
  });

  it.each(["after-intent", "after-cas"] as const)(
    "recovers exactly once across restart %s",
    async (crashPoint) => {
      // Given
      const fixture = await nativeBundleReviewFixture(`installed-promotion-${crashPoint}`, undefined,
        authoritativePolicy(["owner"], [], []), undefined, undefined, undefined, undefined, {}, {
          ...(crashPoint === "after-intent" ? { afterIntent: failPromotion } : {
            afterCompareAndSwap: failPromotion
          })
        });
      const created = await post(fixture.service.origin,
        "/v1/projects/project-a/repositories/root/reviews/resolve", humanReviewerAuthorization,
        { schemaVersion: 1, proposalRef: reviewProposalRef });
      const review = field(created.body, "review");
      const reviewId = review.reviewId;
      if (typeof reviewId !== "string") throw new TypeError("review ID is missing");
      await post(fixture.service.origin,
        `/v1/projects/project-a/repositories/root/reviews/${reviewId}/approvals`, humanReviewerAuthorization,
        { requestId: randomUUID() });
      const interrupted = await post(fixture.service.origin,
        `/v1/projects/project-a/repositories/root/reviews/${reviewId}/promotions`, hostPromoterAuthorization,
        { schemaVersion: 1 });
      expect(interrupted.response.status).toBe(409);
      await closeFinalizeService(fixture.service);

      // When
      const restarted = await startFinalizeService(fixture.root);
      await activateFinalizeService(restarted.origin);
      const replay = await post(restarted.origin,
        `/v1/projects/project-a/repositories/root/reviews/${reviewId}/promotions`, hostPromoterAuthorization,
        { schemaVersion: 1 });

      // Then
      expect(replay.response.status, JSON.stringify(replay.body)).toBe(200);
      expect(replay.body).toMatchObject({ outcome: "already-current", reviewId });
      expect(await protectedHead(fixture.root)).toBe(review.candidateCommit);
      const database = new DatabaseSync(`${fixture.root}/native-idle.sqlite3`, { readOnly: true });
      try {
        expect(database.prepare("SELECT COUNT(*) AS count FROM native_project_root_promotion_intent").get()?.count).toBe(0);
        expect(database.prepare("SELECT COUNT(*) AS count FROM native_project_root_promotion_finalized").get()?.count).toBe(1);
      } finally { database.close(); }
    }
  );
});

async function post(origin: string, path: string, authorization: string, body: object) {
  const response = await fetch(`${origin}${path}`, { method: "POST", headers: {
    authorization, "content-type": "application/json", "x-dim-generation-id": generationId
  }, body: JSON.stringify(body) });
  return { response, body: await response.json() as unknown };
}

function field(value: unknown, key: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("expected object");
  const selected = Reflect.get(value, key);
  if (typeof selected !== "object" || selected === null || Array.isArray(selected)) throw new TypeError("expected field");
  return Object.fromEntries(Object.keys(selected).map((name) => [name, Reflect.get(selected, name)]));
}

function stringField(value: unknown, key: string): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("expected object");
  const selected = Reflect.get(value, key);
  if (typeof selected !== "string") throw new TypeError("expected string field");
  return selected;
}

async function protectedHead(root: string): Promise<string> {
  return (await runGit("/usr/bin/git", ["--git-dir", rootRepository(root), "rev-parse", "refs/heads/main"])).stdout.trim();
}

async function connectionFile(path: string, endpoint: string, role: "human-reviewer" | "host-promoter",
  identity: { readonly username: string; readonly password: string }): Promise<void> {
  await writeFile(path, `${JSON.stringify({ schemaVersion: 1, role, serviceId: "native-main", endpoint,
    generationId, username: identity.username, password: identity.password })}\n`, { mode: 0o600 });
}

async function cli(arguments_: readonly string[]): Promise<string> {
  const cliPath = join(import.meta.dirname, "../../../../core/packages/native-git/src/cli.ts");
  const result = await execute(process.execPath, ["--import", "tsx", cliPath, "operator", "review", ...arguments_],
    { env: { ...process.env, TMPDIR: "/tmp" } });
  return result.stdout;
}

function failPromotion(): never {
  throw new Error("simulated promotion interruption");
}
