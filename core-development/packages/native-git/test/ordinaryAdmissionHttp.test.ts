import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createConfiguredNativeGitServer,
  createOrdinaryAdmissionVerifier,
  parseNativeGitServiceConfig
} from "../../../../core/packages/native-git/src/index.js";
import {
  createApprovedReview,
  issueJob,
  promote,
  protectedHead,
  reportJob,
  reportRequiredJobs,
  requestJob
} from "./nativeGitPromotionHarness.js";
import {
  nativeGitReviewFixture,
  type ReviewFixture
} from "./nativeGitReviewHarness.js";
import {
  closeOrdinaryFixtures,
  currentAttempt,
  nativeConfigInput,
  ordinaryConfig,
  ordinaryFixture,
  queryAuthorization
} from "./ordinaryAdmissionHttpFixture.js";

const nativeFixtures: ReviewFixture[] = [];

afterEach(async () => {
  await Promise.all(nativeFixtures.splice(0).map((fixture) => fixture.close()));
  await closeOrdinaryFixtures();
});

describe("ordinary admission verifier HTTP client", () => {
  it("attests the pinned service and sends only query authorization to exact no-redirect routes", async () => {
    const ordinary = await ordinaryFixture();

    await createOrdinaryAdmissionVerifier({
      config: ordinaryConfig(),
      httpClient: ordinary.client
    });

    expect(ordinary.requests).toEqual([{
      method: "GET",
      path: "/v1/identity",
      authorization: queryAuthorization,
      body: ""
    }]);
    expect(JSON.stringify(ordinary.requests)).not.toContain("identity-secret-00000000000000000000");
    expect(JSON.stringify(ordinary.requests)).not.toContain("attempt-credential-secret");
    expect(JSON.stringify(ordinary.requests)).not.toContain("reporter-credential-secret");
    expect(JSON.stringify(ordinary.requests)).not.toContain("webhook-secret-000000000000000000000");
  });

  it.each([
    ["foreign service identity", "foreign-identity"],
    ["wrong credential scope", "wrong-scope"],
    ["malformed identity", "malformed"],
    ["redirect", "redirect"],
    ["missing authorization", "unauthorized"],
    ["transport failure", "transport-failure"]
  ] as const)("rejects %s during startup attestation", async (_label, mode) => {
    const ordinary = await ordinaryFixture();
    ordinary.mode = mode;

    const verifier = createOrdinaryAdmissionVerifier({
      config: ordinaryConfig(),
      httpClient: ordinary.client,
      timeoutMilliseconds: 50
    });

    await expect(verifier).rejects.toThrow(/ordinary CI/);
  });

  it("attests before registering the verifier or creating native service state", async () => {
    const ordinary = await ordinaryFixture();
    ordinary.mode = "foreign-identity";
    const root = await mkdtemp(join(tmpdir(), "dim-native-admission-startup-"));
    const storageRoot = join(root, "storage");
    const config = parseNativeGitServiceConfig({ ...nativeConfigInput(), storageRoot });

    try {
      await expect(createConfiguredNativeGitServer(config, ordinary.client)).rejects.toThrow(/ordinary CI/);
      await expect(access(storageRoot)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a replayed response and every mismatched current-attempt field", async () => {
    const ordinary = await ordinaryFixture();
    const verifier = await createOrdinaryAdmissionVerifier({ config: ordinaryConfig(), httpClient: ordinary.client });
    const current = currentAttempt();
    await verifier.assertCurrentAttempt(current, AbortSignal.timeout(1_000));
    ordinary.mode = "replay";

    for (const input of [
      { ...current, reviewId: "b".repeat(64) },
      { ...current, attemptId: "11111111-1111-4111-8111-111111111111" },
      { ...current, descriptorDigest: `sha256:${"b".repeat(64)}` },
      { ...current, admissionGeneration: "generation-8" },
      { ...current, hostId: "host-b" },
      { ...current, capacity: "secondary" }
    ]) {
      await expect(verifier.assertCurrentAttempt(input, AbortSignal.timeout(1_000))).rejects.toThrow(/ordinary CI/);
    }
  });

  it("drives native issue, report, and promotion through a real authenticated ordinary service", async () => {
    const ordinary = await ordinaryFixture();
    const verifier = await createOrdinaryAdmissionVerifier({ config: ordinaryConfig(), httpClient: ordinary.client });
    const native = await nativeGitReviewFixture(verifier);
    nativeFixtures.push(native);
    const review = await createApprovedReview(native);

    await reportRequiredJobs(native, review);
    const response = await promote(native, review);

    expect(response.status).toBe(201);
    expect(await protectedHead(native)).not.toBe(native.protectedHead);
    expect(ordinary.requests.filter((request) => request.path === "/v1/admission-verifications")).toHaveLength(2);
    expect(ordinary.requests.filter((request) => request.path === "/v1/current-attempt-verifications")).toHaveLength(4);
  });

  it("fails closed before attempt, status, and ref mutation on timeout, malformed response, and revocation", async () => {
    const ordinary = await ordinaryFixture();
    const verifier = await createOrdinaryAdmissionVerifier({ config: ordinaryConfig(), httpClient: ordinary.client });
    const native = await nativeGitReviewFixture(verifier);
    nativeFixtures.push(native);
    const review = await createApprovedReview(native);
    const before = await protectedHead(native);
    ordinary.mode = "timeout";

    expect((await requestJob(native, review, "source")).status).toBe(500);
    ordinary.mode = "correct";
    const source = await issueJob(native, review, "source");
    expect(source["attempt"]).toBe(1);
    ordinary.mode = "malformed";
    expect((await reportJob(native, review, "source", source)).status).toBe(500);
    ordinary.mode = "correct";
    expect((await reportJob(native, review, "source", source)).status).toBe(201);
    const security = await issueJob(native, review, "security");
    expect((await reportJob(native, review, "security", security)).status).toBe(201);
    ordinary.mode = "revoked";

    expect((await promote(native, review)).status).toBe(500);
    expect(await protectedHead(native)).toBe(before);
  });

  it("validates the fixed endpoint and globally distinct service credentials", () => {
    const base = nativeConfigInput();

    expect(() => parseNativeGitServiceConfig({ ...base, schemaVersion: 1 })).toThrow();
    expect(() => parseNativeGitServiceConfig({ ...base, serviceId: "native-secondary" })).toThrow();
    expect(() => parseNativeGitServiceConfig({
      ...base,
      ordinaryCi: { ...ordinaryConfig(), endpoint: "http://127.0.0.1:8080" }
    })).toThrow();
    expect(() => parseNativeGitServiceConfig({
      ...base,
      ordinaryCi: { ...ordinaryConfig(), serviceId: "ordinary-secondary" }
    })).toThrow();
    expect(() => parseNativeGitServiceConfig({
      ...base,
      ordinaryCi: {
        ...ordinaryConfig(),
        identity: { username: "ordinary-identity", password: "query-credential-secret" }
      }
    })).toThrow(/distinct/);
    expect(() => parseNativeGitServiceConfig({
      ...base,
      ordinaryCi: {
        ...ordinaryConfig(),
        webhook: { ...ordinaryConfig().webhook, password: "reporter-credential-secret" }
      }
    })).toThrow(/distinct/);
    expect(() => parseNativeGitServiceConfig({
      ...base,
      identities: [{
        role: "reader",
        username: "native-main",
        password: "reader-native-secret",
        projectId: "project-a",
        repositoryIds: ["source"]
      }]
    })).toThrow(/distinct/);
  });
});
