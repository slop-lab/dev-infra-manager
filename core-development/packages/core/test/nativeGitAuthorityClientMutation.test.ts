import { describe, expect, it } from "vitest";
import { createNativeGitAdmissionSource } from "../../../../core/packages/core/src/nativeGitAdmissionSource.js";
import {
  createNativeGitResultReporterClient,
  type NativeGitResultReporterConfig
} from "../../../../core/packages/core/src/nativeGitResultReporter.js";
import { nativeDescriptorDigest } from "../../../../core/packages/core/src/nativeOrdinaryAuthorityModel.js";
import { statusDigest } from "../../../../core/packages/native-git/src/promotion-schema.js";
import { admission, descriptor } from "./nativeOrdinaryAuthorityFixture.js";

const identityCredential = {
  username: "ordinary-identity",
  password: "identity-secret-00000000000000000000"
} as const;
const reporterCredential = {
  username: "ordinary-results",
  password: "result-secret-0000000000000000000000"
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

  it("retains reporter endpoint and credential after caller config mutation", async () => {
    // Given
    const seen: { readonly endpoint: string; readonly authorization: string }[] = [];
    const config: NativeGitResultReporterConfig = {
      endpoint: "http://native-git:8080",
      serviceId: "native-main",
      resultReporter: { ...reporterCredential }
    };
    const client = createNativeGitResultReporterClient(config, {
      async request(input) {
        seen.push({ endpoint: input.endpoint, authorization: input.authorization });
        const event = terminalEvent();
        const identity = { ...event, reviewId: event.payload.reviewId, reporterUsername: reporterCredential.username };
        return response(201, { ...identity, statusId: statusDigest(identity), reportedAt: event.occurredAt });
      }
    });
    Reflect.set(config, "endpoint", "http://attacker.invalid:9999");
    Reflect.set(config, "serviceId", "attacker-native");
    Reflect.set(config.resultReporter, "username", "attacker");
    Reflect.set(config.resultReporter, "password", "attacker-password-0000000000000000");

    // When
    await expect(client.send(JSON.stringify(terminalEvent()), terminalEvent(), AbortSignal.timeout(1_000)))
      .resolves.toBe("acknowledged");

    // Then
    expect(seen).toEqual([{
      endpoint: "http://native-git:8080",
      authorization: basic(reporterCredential)
    }]);
  });
});

function terminalEvent() {
  const value = descriptor("project-a", "source", "generation-1");
  const now = "2026-10-05T00:00:00.000Z";
  return {
    schemaVersion: 2,
    eventId: "60000000-0000-4000-8000-000000000061",
    occurredAt: now,
    eventType: "dim.ci.job.completed",
    payload: {
      reviewId: "a".repeat(64),
      attemptId: "10000000-0000-4000-8000-000000000061",
      attempt: 1,
      descriptor: value,
      descriptorDigest: nativeDescriptorDigest(value),
      hostId: "host-a",
      capacity: "primary",
      startedAt: now,
      finishedAt: now,
      result: "success",
      completion: { kind: "exited", exitCode: 0 },
      stdout: { bytes: "0", sha256: `sha256:${"0".repeat(64)}`, truncated: false },
      stderr: { bytes: "0", sha256: `sha256:${"0".repeat(64)}`, truncated: false }
    }
  } as const;
}

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
