import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createNativeRootCiProofClient,
  NativeRootCiProofUnavailableError,
  type NativeRootCiProofHttpClient
} from "../../../../core/packages/core/src/nativeRootCiProofClient.js";
import { generationId } from "../../native-git/test/nativeRootImportFinalizeFixture.js";

const credential = { username: "ordinary-identity", password: "identity-secret" } as const;
const scope = ["imported-policy:read", "ordinary-review-event:read"] as const;

describe("native root CI proof client protocol", () => {
  it.each([
    ["role", { role: "ordinary-authority-reader" }],
    ["scope", { scope: [...scope].reverse() }],
    ["generation", { generationId: "b".repeat(64) }],
    ["service", { serviceId: "foreign" }],
    ["shape", { extra: true }]
  ])("rejects a wrong identity %s before requesting proof", async (_label, change) => {
    // Given
    let requests = 0;
    const client = createNativeRootCiProofClient(config(), {
      async request() {
        requests += 1;
        return response({ ...identity(), ...change });
      }
    });

    // When / Then
    await expect(client.readImportedPolicy("project-a", AbortSignal.timeout(1_000)))
      .rejects.toThrow(NativeRootCiProofUnavailableError);
    expect(requests).toBe(1);
  });

  it("sends an exact ordinary selector and rejects a caller-cancelled transport without leaking the credential", async () => {
    // Given
    const requests: Parameters<NativeRootCiProofHttpClient["request"]>[0][] = [];
    const controller = new AbortController();
    const client = createNativeRootCiProofClient(config(), {
      request(input) {
        requests.push(input);
        if (input.method === "GET") return Promise.resolve(response(identity()));
        return new Promise((_resolve, reject) => input.signal.addEventListener("abort",
          () => reject(input.signal.reason), { once: true }));
      }
    });
    const selector = { projectId: "project-a", importNonce: "00000000-0000-4000-8000-000000000032",
      policyDigest: "1".repeat(64), eventId: eventId(), reviewId: "a".repeat(64),
      executionKind: "ordinary-sysbox" as const, jobName: "source" };

    // When
    const pending = client.readOrdinaryReviewEvent(selector, controller.signal);
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort();

    // Then
    await expect(pending).rejects.toThrow(NativeRootCiProofUnavailableError);
    expect(requests).toHaveLength(2);
    const proof = requests.at(1);
    if (proof === undefined || proof.body === undefined) throw new TypeError("proof request is missing");
    const body: unknown = JSON.parse(proof.body);
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw new TypeError("body is invalid");
    expect(Object.keys(body).sort()).toEqual(["eventId", "executionKind", "generationId", "importNonce", "jobName",
      "policyDigest", "requestId", "reviewId", "schemaVersion"]);
    expect(proof.path).toBe("/v1/projects/project-a/repositories/root/native-root-ci-proof/review-event");
    expect(String(await pending.catch((error: unknown) => error))).not.toContain(credential.password);
  });
});

function config() {
  return { endpoint: "http://native-git:8080", serviceId: "native-main", generationId,
    identity: { ...credential } } as const;
}

function identity() {
  return { schemaVersion: 1, serviceId: "native-main", role: "native-root-ci-proof-reader", scope, generationId };
}

function response(body: unknown) {
  return { statusCode: 200, contentType: "application/json; charset=utf-8", cacheControl: "no-store",
    body: Buffer.from(JSON.stringify(body)) };
}

function eventId(): string {
  return createHash("sha256").update("dim-native-authoritative-review-event-v1\0")
    .update(JSON.stringify({ executionKind: "ordinary-sysbox", jobName: "source", reviewId: "a".repeat(64) }))
    .digest("hex");
}
