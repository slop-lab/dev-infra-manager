import { afterEach, describe, expect, it } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  createNativeGitAttemptIssuerClient,
  type NativeGitAttemptIssuerHttpClient
} from "../../../../core/packages/core/src/nativeGitAttemptIssuerClient.js";
import { createNodeNativeGitAdmissionHttpClient } from "../../../../core/packages/core/src/nativeGitAdmissionSource.js";
import { bundleSecrets } from "../../native-git/test/bundleConfigFixture.js";
import { generationId } from "../../native-git/test/nativeRootImportFinalizeFixture.js";
import { parseNativeRootCiClaim } from "../../../../core/packages/core/src/nativeRootCiClaimProtocol.js";
import {
  claimRequest,
  hostAuthorization,
  post,
  registrarAuthorization,
  reservationFixture,
  type ReservationFixture
} from "./nativeRootClaimReservationFixture.js";

const attemptIssuer = {
  username: "ordinary-attempts",
  password: bundleSecrets.attemptIssuer
} as const;
const fixtures: ReservationFixture[] = [];
afterEach(async () => Promise.all(fixtures.splice(0).map((fixture) => fixture.close())));

describe("native Git attempt issuer installed protocol", () => {
  it("drives descriptor, lost-response replay, and revocation over real HTTP", async () => {
    // Given
    const fixture = await reservationFixture("core-attempt-issuer-installed");
    fixtures.push(fixture);
    const reserved = await post(fixture.origin, "/v1/host-claims", hostAuthorization("host-a"),
      claimRequest("20000000-0000-4000-8000-000000000101", "host-a", "primary"));
    expect(reserved.status).toBe(201);
    const context = { claim: parseNativeRootCiClaim(reserved.body) } as const;
    const transport = createNodeNativeGitAdmissionHttpClient();
    const issueBodies: string[] = [];
    let loseFirstIssueResponse = true;
    const httpClient: NativeGitAttemptIssuerHttpClient = {
      async request(input) {
        const response = await transport.request({ ...input, endpoint: fixture.nativeOrigin });
        if (!input.path.endsWith("/job-attempts")) return response;
        issueBodies.push(input.body ?? "");
        if (loseFirstIssueResponse) {
          loseFirstIssueResponse = false;
          throw new Error("response lost after native persistence");
        }
        return response;
      }
    };
    const config = {
      endpoint: "http://native-git:8080",
      serviceId: "native-main",
      attemptIssuer
    } as const;
    const client = createNativeGitAttemptIssuerClient({ config, generationId, httpClient });
    const descriptor = await client.loadDescriptor(context);
    const issuePath = `/v1/projects/project-a/repositories/root/reviews/${context.claim.event.reviewId}/job-attempts`;
    const issueBody = { schemaVersion: 1, descriptorDigest: descriptor.digest, claim: context.claim } as const;
    const invalidStatuses = await Promise.all([
      issueDirect(fixture.nativeOrigin, issuePath, { ...issueBody, claim: {
        ...context.claim,
        claimId: "00000000-0000-4000-8000-000000000201",
        issuanceRequestId: "00000000-0000-4000-8000-000000000201"
      } }),
      issueDirect(fixture.nativeOrigin, issuePath, { ...issueBody, claim: { ...context.claim, hostId: "host-b" } }),
      issueDirect(fixture.nativeOrigin, issuePath, { ...issueBody, claim: {
        ...context.claim,
        jobBaseImage: `registry.example/forged@sha256:${"9".repeat(64)}`
      } }),
      issueDirect(fixture.nativeOrigin, issuePath, { ...issueBody, claim: {
        ...context.claim,
        bounds: { ...context.claim.bounds, cpu: "9" }
      } }),
      issueDirect(fixture.nativeOrigin, issuePath, { ...issueBody, claim: {
        ...context.claim,
        event: { ...context.claim.event, candidateCommit: "9".repeat(40) }
      } })
    ]);
    const duplicateReservation = await post(fixture.origin, "/v1/host-claims", hostAuthorization("host-a"),
      claimRequest("20000000-0000-4000-8000-000000000202", "host-a", "primary"));
    expect(await attemptFiles(fixture.nativeRoot, context.claim.event.reviewId)).toEqual([]);
    const issue = {
      context,
      descriptor
    } as const;

    // When
    await expect(client.issueAttempt(issue)).rejects.toThrow(/unavailable/);
    const replay = await client.issueAttempt(issue);
    const attemptFile = join(fixture.nativeRoot, "project-a", "root.git", "dim-authoritative-attempts",
      "ordinary-sysbox", "issuances", context.claim.event.reviewId, context.claim.event.jobName, "1.json");
    const durableBytes = await readFile(attemptFile);
    const database = new DatabaseSync(fixture.database);
    const admission = database.prepare("SELECT lease_expires_at FROM native_root_admissions WHERE admission_generation = ?")
      .get(fixture.admissionGeneration);
    if (admission === undefined || typeof admission.lease_expires_at !== "number") {
      throw new TypeError("admission expiry is missing");
    }
    database.prepare("UPDATE native_root_admissions SET lease_expires_at = 1 WHERE admission_generation = ?")
      .run(fixture.admissionGeneration);
    const expired = await issueDirect(fixture.nativeOrigin, issuePath, issueBody);
    database.prepare("UPDATE native_root_admissions SET lease_expires_at = ? WHERE admission_generation = ?")
      .run(admission.lease_expires_at, fixture.admissionGeneration);
    database.close();
    const revokedAdmission = await post(fixture.origin,
      "/v1/projects/project-a/repositories/root/native-root-admission/revoke", registrarAuthorization(), {
        schemaVersion: 1,
        requestId: randomUUID(),
        generationId,
        admissionGeneration: fixture.admissionGeneration
      });
    const afterRevocation = await issueDirect(fixture.nativeOrigin, issuePath, issueBody);
    const replacement = await post(fixture.origin,
      "/v1/projects/project-a/repositories/root/native-root-admission/register", registrarAuthorization(), {
        schemaVersion: 1,
        requestId: randomUUID(),
        generationId
      });
    const afterReplacement = await issueDirect(fixture.nativeOrigin, issuePath, issueBody);
    fixture.server.closeAllConnections();
    await new Promise<void>((resolve, reject) => fixture.server.close((error) => error === undefined ? resolve() : reject(error)));
    const outage = await issueDirect(fixture.nativeOrigin, issuePath, issueBody);
    const restarted = await fixture.restart();
    fixtures.push(restarted);
    const staleEpochReplay = await issueDirect(fixture.nativeOrigin, issuePath, issueBody);
    const revocation = await client.revokeAttempt(replay.issuance);

    // Then
    expect(issueBodies).toHaveLength(2);
    expect(new Set(issueBodies).size).toBe(1);
    expect(invalidStatuses).toEqual([409, 409, 409, 409, 409]);
    expect(duplicateReservation.status).toBe(409);
    expect([expired, revokedAdmission.status, afterRevocation, replacement.status, afterReplacement])
      .toEqual([409, 200, 409, 200, 409]);
    expect(outage).toBe(503);
    expect(staleEpochReplay).toBe(201);
    expect(await readFile(attemptFile)).toEqual(durableBytes);
    expect(replay.issuance).toMatchObject({
      schemaVersion: 3,
      executionKind: "ordinary-sysbox",
      issuanceRequestId: record(context.claim).claimId,
      descriptorDigest: descriptor.digest,
      issuedBy: attemptIssuer.username
    });
    expect(revocation).toMatchObject({
      schemaVersion: 3,
      executionKind: "ordinary-sysbox",
      revocationRequestId: replay.issuance.attemptId,
      attemptId: replay.issuance.attemptId,
      revokedBy: attemptIssuer.username
    });
  }, 20_000);
});

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("record is invalid");
  return Object.fromEntries(Object.keys(value).map((key) => [key, Reflect.get(value, key)]));
}

async function issueDirect(origin: string, path: string, body: object): Promise<number> {
  const response = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${attemptIssuer.username}:${attemptIssuer.password}`).toString("base64")}`,
      "content-type": "application/json",
      "x-dim-generation-id": generationId
    },
    body: JSON.stringify(body)
  });
  return response.status;
}

async function attemptFiles(root: string, reviewId: string): Promise<readonly string[]> {
  try {
    return await readdir(join(root, "project-a", "root.git", "dim-authoritative-attempts",
      "ordinary-sysbox", "issuances", reviewId, "source"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}
