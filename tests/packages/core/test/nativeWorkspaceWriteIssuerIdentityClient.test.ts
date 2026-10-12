import { describe, expect, it } from "vitest";
import type { NativeControlPlaneConnection } from "../../../../core/packages/core/src/nativeControlPlaneConnection.js";
import type { NativeGitAdmissionHttpClient } from "../../../../core/packages/core/src/nativeGitAdmissionSource.js";
import {
  attestNativeWorkspaceWriteIssuer,
  NativeProjectReadinessClientError
} from "../../../../core/packages/core/src/nativeProjectReadinessClient.js";

const generationId = "b".repeat(64);
const password = Buffer.alloc(32, 20).toString("base64url");
const connection: NativeControlPlaneConnection = {
  schemaVersion: 1,
  hostId: "host-a",
  nativeGit: {
    transport: "loopback-http",
    endpoint: "http://127.0.0.1:9080",
    serviceId: "native-main",
    generationId,
    workspaceWriteIssuer: { username: "host-a", password },
    rootReadIssuer: { username: "root-read-a", password: Buffer.alloc(32, 21).toString("base64url") }
  }
};

describe("native workspace write issuer identity client", () => {
  it("accepts a fresh exact identity matching the configured serving generation", async () => {
    // Given
    const requests: unknown[] = [];
    const client = identityClient({ generationId }, requests);

    // When
    const identity = await attestNativeWorkspaceWriteIssuer(connection, AbortSignal.timeout(5_000), client);

    // Then
    expect(identity).toEqual({ schemaVersion: 1, serviceId: "native-main",
      role: "operator-workspace-write-issuer", hostId: "host-a", generationId });
    expect(requests).toMatchObject([{
      endpoint: connection.nativeGit.endpoint,
      method: "GET",
      path: "/v1/operator-workspace-write-issuer-identity",
      authorization: `Basic ${Buffer.from(`host-a:${password}`).toString("base64")}`
    }]);
  });

  it.each([
    ["wrong service", { serviceId: "native-other" }],
    ["wrong role", { role: "operator-root-read-issuer" }],
    ["wrong host", { hostId: "host-b" }],
    ["stale generation", { generationId: "a".repeat(64) }],
    ["malformed generation", { generationId: "current" }],
    ["extra field", { extra: true }]
  ] as const)("rejects a %s identity proof", async (_label, change) => {
    // Given
    const client = identityClient(change);

    // When / Then
    await expect(attestNativeWorkspaceWriteIssuer(connection, AbortSignal.timeout(5_000), client))
      .rejects.toBeInstanceOf(NativeProjectReadinessClientError);
  });

  it.each([
    ["wrong status", { statusCode: 201 }],
    ["wrong content type", { contentType: "text/plain" }],
    ["cacheable", { cacheControl: "max-age=1" }],
    ["malformed JSON", { rawBody: "{" }]
  ] as const)("rejects a %s response", async (_label, change) => {
    // Given
    const client = identityClient({}, [], change);

    // When / Then
    await expect(attestNativeWorkspaceWriteIssuer(connection, AbortSignal.timeout(5_000), client))
      .rejects.toBeInstanceOf(NativeProjectReadinessClientError);
  });
});

function identityClient(
  bodyChange: Readonly<Record<string, unknown>>,
  requests: unknown[] = [],
  responseChange: Readonly<Record<string, unknown>> = {}
): NativeGitAdmissionHttpClient {
  return {
    async request(input) {
      requests.push(input);
      const body = { schemaVersion: 1, serviceId: "native-main", role: "operator-workspace-write-issuer",
        hostId: "host-a", generationId, ...bodyChange };
      return {
        statusCode: typeof responseChange.statusCode === "number" ? responseChange.statusCode : 200,
        contentType: typeof responseChange.contentType === "string" ? responseChange.contentType : "application/json",
        cacheControl: typeof responseChange.cacheControl === "string" ? responseChange.cacheControl : "no-store",
        body: Buffer.from(typeof responseChange.rawBody === "string" ? responseChange.rawBody : JSON.stringify(body))
      };
    }
  };
}
