import { describe, expect, it } from "vitest";
import { createNativeGitAdmissionSource } from "../../../../core/packages/managed/src/nativeGitAdmissionSource.js";
import { admission } from "./nativeOrdinaryDescriptorFixture.js";

const identityCredential = {
  username: "ordinary-identity",
  password: "identity-secret-00000000000000000000"
} as const;

describe("native Git authority client mutation boundaries", () => {
  it("retains admission endpoint, service identity, and credential after caller config mutation", async () => {
    // Given
    const seen: { readonly endpoint: string; readonly authorization: string }[] = [];
    const policy = admission("project-a", "source", "1");
    const config = {
      endpoint: "http://native-git:8080",
      serviceId: "native-main",
      identity: { ...identityCredential },
      attemptIssuer: { username: "ordinary-attempts", password: "attempt-secret-000000000000000000000" }
    } as const;
    const source = createNativeGitAdmissionSource({
      config,
      httpClient: {
        async request(input) {
          seen.push({ endpoint: input.endpoint, authorization: input.authorization });
          if (input.method === "GET") return response(200, {
            schemaVersion: 1,
            serviceId: "native-main",
            role: "ordinary-authority-reader",
            scope: ["policy:read", "review-event:read", "attempt:read"]
          });
          const request = parseObject(input.body ?? "");
          return response(200, {
            schemaVersion: 1,
            serviceId: "native-main",
            requestId: request.requestId,
            policy
          });
        }
      }
    });
    Reflect.set(config, "endpoint", "http://attacker.invalid:9999");
    Reflect.set(config, "serviceId", "attacker-native");
    Reflect.set(config.identity, "username", "attacker");
    Reflect.set(config.identity, "password", "attacker-password-0000000000000000");

    // When
    await source.assertRegisteredPolicy(policy);

    // Then
    expect(seen).toHaveLength(2);
    expect(seen.every((request) => request.endpoint === "http://native-git:8080")).toBe(true);
    expect(seen.every((request) => request.authorization === basic(identityCredential))).toBe(true);
  });

});

function response(statusCode: number, body: unknown) {
  return {
    statusCode,
    contentType: "application/json; charset=utf-8",
    cacheControl: "no-store",
    body: Buffer.from(JSON.stringify(body))
  };
}

function parseObject(value: string): Readonly<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new TypeError("expected object");
  return Object.fromEntries(Object.keys(parsed).map((key) => [key, Reflect.get(parsed, key)]));
}

function basic(credential: { readonly username: string; readonly password: string }): string {
  return `Basic ${Buffer.from(`${credential.username}:${credential.password}`, "utf8").toString("base64")}`;
}
