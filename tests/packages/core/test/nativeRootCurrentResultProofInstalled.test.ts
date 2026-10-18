import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { nativeRootCiTerminalEventDigest } from "../../../../core/packages/managed/src/nativeRootCiResultProtocol.js";
import { parseNativeRootCiCurrentResultProof } from "../../../../core/packages/managed/src/nativeRootCiResultProofModel.js";
import { generationId } from "../../native-git/test/nativeRootImportFinalizeFixture.js";
import {
  queryAuthorization,
  reservationFixture,
  type ReservationFixture
} from "./nativeRootClaimReservationFixture.js";
import { activeAttempt, resultRequest, resultRows } from "./nativeRootHostResultFixture.js";
import { hostAuthorization, post } from "./nativeRootClaimReservationFixture.js";

const fixtures: ReservationFixture[] = [];

afterEach(async () => Promise.all(fixtures.splice(0).map((fixture) => fixture.close())));

describe("installed native ordinary current-result proof", () => {
  it("returns the exact current cleaned result and pending outbox evidence without writes", async () => {
    // Given
    const fixture = await reservationFixture("installed-current-result-proof");
    fixtures.push(fixture);
    const active = await activeAttempt(fixture, "601");
    const result = resultRequest(active.claim, active.issuance, "701");
    expect((await post(fixture.origin, "/v1/host-results", hostAuthorization("host-a"), result)).status).toBe(202);
    const before = resultRows(fixture.database);
    const requestId = randomUUID();

    // When
    const response = await proof(fixture.origin, active.claim.admission.projectId, { authorization: queryAuthorization(), body: {
      schemaVersion: 1,
      requestId,
      generationId,
      terminalEvent: result.terminalEvent
    } });

    // Then
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toBe("application/json");
    const responseBody: unknown = await response.json();
    const expected = {
      serviceId: "ordinary-main",
      requestId,
      generationId,
      projectId: active.claim.admission.projectId,
      terminalEvent: result.terminalEvent
    } as const;
    const parsed = parseNativeRootCiCurrentResultProof(responseBody, expected);
    expect(parsed).toEqual({
      schemaVersion: 1,
      serviceId: "ordinary-main",
      requestId,
      servingGenerationId: generationId,
      projectId: active.claim.admission.projectId,
      repositoryId: "root",
      claimId: active.claim.claimId,
      serviceEpochId: active.claim.serviceEpochId,
      admissionGeneration: active.claim.admissionGeneration,
      rootSequence: active.claim.admission.rootSequence,
      rootCommit: active.claim.admission.rootCommit,
      rootTree: active.claim.admission.rootTree,
      cleanupComplete: true,
      terminalEvent: result.terminalEvent,
      terminalEventDigest: nativeRootCiTerminalEventDigest(result.terminalEvent)
    });
    expect(() => parseNativeRootCiCurrentResultProof({ ...parsed, unexpected: true }, expected)).toThrow();
    expect(() => parseNativeRootCiCurrentResultProof({ ...parsed,
      terminalEventDigest: `sha256:${"f".repeat(64)}` }, expected)).toThrow();
    expect(() => parseNativeRootCiCurrentResultProof(parsed, { ...expected,
      terminalEvent: { ...result.terminalEvent, eventId: randomUUID() } })).toThrow();
    expect(resultRows(fixture.database)).toEqual(before);
  }, 20_000);

  it("rejects unauthorized, foreign, stale, and inactive tuples without writes", async () => {
    // Given
    const fixture = await reservationFixture("installed-current-result-proof-rejections");
    fixtures.push(fixture);
    const active = await activeAttempt(fixture, "611");
    const result = resultRequest(active.claim, active.issuance, "711");
    expect((await post(fixture.origin, "/v1/host-results", hostAuthorization("host-a"), result)).status).toBe(202);
    const before = proofRows(fixture.database);
    const body = proofBody(result.terminalEvent);

    // When
    const unknown = await proof(fixture.origin, active.claim.admission.projectId, {
      authorization: `Basic ${Buffer.from("unknown:unknown").toString("base64")}`, body });
    const wrongRole = await proof(fixture.origin, active.claim.admission.projectId,
      { authorization: hostAuthorization("host-a"), body });
    const foreignProject = await proof(fixture.origin, "project-b", { authorization: queryAuthorization(), body });
    const foreignHost = await proof(fixture.origin, active.claim.admission.projectId, { authorization: queryAuthorization(),
      body: proofBody({ ...result.terminalEvent, payload: { ...result.terminalEvent.payload, hostId: "host-b" } }) });
    const foreignAttempt = await proof(fixture.origin, active.claim.admission.projectId, { authorization: queryAuthorization(),
      body: proofBody({ ...result.terminalEvent, payload: { ...result.terminalEvent.payload, attemptId: randomUUID() } }) });
    const staleGeneration = await proof(fixture.origin, active.claim.admission.projectId, { authorization: queryAuthorization(),
      body: { ...body, requestId: randomUUID(), generationId: "f".repeat(64) } });
    const database = new DatabaseSync(fixture.database);
    database.prepare("UPDATE native_root_ci_service_epochs SET active = 0").run();
    const oldEpoch = await proof(fixture.origin, active.claim.admission.projectId,
      { authorization: queryAuthorization(), body: proofBody(result.terminalEvent) });
    database.prepare("UPDATE native_root_ci_service_epochs SET active = 1").run();
    database.prepare("UPDATE native_root_admissions SET state = 'revoked'").run();
    const staleAdmission = await proof(fixture.origin, active.claim.admission.projectId,
      { authorization: queryAuthorization(), body: proofBody(result.terminalEvent) });
    database.prepare("UPDATE native_root_admissions SET state = 'active'").run();
    database.prepare("UPDATE native_root_admissions SET root_sequence = root_sequence + 1, root_commit = ?, root_tree = ?")
      .run("8".repeat(40), "9".repeat(40));
    const staleRoot = await proof(fixture.origin, active.claim.admission.projectId,
      { authorization: queryAuthorization(), body: proofBody(result.terminalEvent) });
    database.prepare("UPDATE native_root_admissions SET root_sequence = ?, root_commit = ?, root_tree = ?")
      .run(active.claim.admission.rootSequence, active.claim.admission.rootCommit, active.claim.admission.rootTree);
    const boundActivationDigest = activationDigest(fixture.database);
    database.prepare("UPDATE bundle_activation SET activation_token_sha256 = ?").run("0".repeat(64));
    const inactive = await proof(fixture.origin, active.claim.admission.projectId,
      { authorization: queryAuthorization(), body: proofBody(result.terminalEvent) });
    database.prepare("UPDATE bundle_activation SET activation_token_sha256 = ?").run(boundActivationDigest);
    database.close();

    // Then
    expect([unknown.status, wrongRole.status, foreignProject.status, foreignHost.status, foreignAttempt.status,
      staleGeneration.status, oldEpoch.status, staleAdmission.status, staleRoot.status, inactive.status])
      .toEqual([401, 403, 404, 404, 404, 409, 200, 409, 409, 503]);
    expect(proofRows(fixture.database)).toEqual(before);
  }, 20_000);

  it("rejects a tampered immutable result without writes", async () => {
    // Given
    const fixture = await reservationFixture("installed-current-result-proof-result-tamper");
    fixtures.push(fixture);
    const active = await activeAttempt(fixture, "621");
    const result = resultRequest(active.claim, active.issuance, "721");
    expect((await post(fixture.origin, "/v1/host-results", hostAuthorization("host-a"), result)).status).toBe(202);
    const database = new DatabaseSync(fixture.database);
    database.exec("DROP TRIGGER native_root_ci_host_results_no_update");
    database.prepare("UPDATE native_root_ci_host_results SET terminal_event_json = ?").run("{}");
    database.close();
    const before = proofRows(fixture.database);

    // When
    const response = await proof(fixture.origin, active.claim.admission.projectId,
      { authorization: queryAuthorization(), body: proofBody(result.terminalEvent) });

    // Then
    expect(response.status).toBe(409);
    expect(proofRows(fixture.database)).toEqual(before);
  }, 20_000);

  it("rejects a tampered pending outbox without writes", async () => {
    // Given
    const fixture = await reservationFixture("installed-current-result-proof-outbox-tamper");
    fixtures.push(fixture);
    const active = await activeAttempt(fixture, "631");
    const result = resultRequest(active.claim, active.issuance, "731");
    expect((await post(fixture.origin, "/v1/host-results", hostAuthorization("host-a"), result)).status).toBe(202);
    const database = new DatabaseSync(fixture.database);
    database.prepare("UPDATE native_root_ci_report_outbox SET terminal_event_json = ?").run("{}");
    database.close();
    const before = proofRows(fixture.database);

    // When
    const response = await proof(fixture.origin, active.claim.admission.projectId,
      { authorization: queryAuthorization(), body: proofBody(result.terminalEvent) });

    // Then
    expect(response.status).toBe(409);
    expect(proofRows(fixture.database)).toEqual(before);
  }, 20_000);
});

function proofBody(terminalEvent: Readonly<Record<string, unknown>>) {
  return { schemaVersion: 1, requestId: randomUUID(), generationId, terminalEvent } as const;
}

function proof(origin: string, projectId: string,
  request: { readonly authorization: string; readonly body: object }): Promise<Response> {
  return fetch(`${origin}/v1/projects/${projectId}/repositories/root/native-root-ci-result-proof/current-result`, {
    method: "POST",
    headers: { authorization: request.authorization, "content-type": "application/json" },
    body: JSON.stringify(request.body)
  });
}

function proofRows(file: string): Readonly<Record<string, unknown>> {
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    return {
      activation: database.prepare("SELECT * FROM bundle_activation").all(),
      epochs: database.prepare("SELECT * FROM native_root_ci_service_epochs").all(),
      admissions: database.prepare("SELECT * FROM native_root_admissions").all(),
      demands: database.prepare("SELECT * FROM native_root_ci_demands").all(),
      claims: database.prepare("SELECT * FROM native_root_ci_claims").all(),
      receipts: database.prepare("SELECT * FROM native_root_ci_claim_receipts").all(),
      results: database.prepare("SELECT * FROM native_root_ci_host_results").all(),
      outbox: database.prepare("SELECT * FROM native_root_ci_report_outbox").all()
    };
  } finally {
    database.close();
  }
}

function activationDigest(file: string): string {
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    const row = database.prepare("SELECT activation_token_sha256 FROM bundle_activation").get();
    const value = row === undefined ? undefined : row.activation_token_sha256;
    if (typeof value !== "string") throw new TypeError("activation digest is unavailable");
    return value;
  } finally {
    database.close();
  }
}
