import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeNativeGitAdmissionHttpClient } from "../../../../core/packages/core/src/nativeGitAdmissionHttpClient.js";
import { nativeRootCiTerminalEventDigest } from "../../../../core/packages/core/src/nativeRootCiResultProtocol.js";
import { parseNativeRootCiCurrentTerminalProof } from "../../../../core/packages/core/src/nativeRootCiTerminalResultProofModel.js";
import { generationId } from "../../native-git/test/nativeRootImportFinalizeFixture.js";
import { bundleSecrets } from "../../native-git/test/bundleConfigFixture.js";
import {
  hostAuthorization,
  post,
  queryAuthorization,
  reservationFixture,
  type ReservationFixture
} from "./nativeRootClaimReservationFixture.js";
import { activeAttempt, resultRequest } from "./nativeRootHostResultFixture.js";

const fixtures: ReservationFixture[] = [];

afterEach(async () => Promise.all(fixtures.splice(0).map((fixture) => fixture.close())));

describe("installed native ordinary current-terminal proof", () => {
  it("returns the exact delivered result and verified acknowledgement after restart without writes", async () => {
    // Given
    const fixture = await deliveredFixture("installed-current-terminal-proof", "801");
    const result = resultRequest(fixture.active.claim, fixture.active.issuance, "901");
    expect((await post(fixture.service.origin, "/v1/host-results", hostAuthorization("host-a"), result)).status).toBe(202);
    await waitFor(() => terminalState(fixture.service.database).outbox === "delivered");
    const restarted = await fixture.service.restart();
    fixtures.push(restarted);
    const before = proofRows(restarted.database);
    const requestId = randomUUID();

    // When
    const response = await proof(restarted.origin, fixture.active.claim.admission.projectId,
      queryAuthorization(), proofBody(result.terminalEvent, requestId));

    // Then
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toBe("application/json");
    const acknowledgement = acknowledgementAt(restarted.database);
    const responseText = await response.text();
    expect(Buffer.byteLength(responseText, "utf8")).toBeLessThanOrEqual(65_536);
    const responseBody: unknown = JSON.parse(responseText);
    expect(responseBody).not.toHaveProperty("terminalEvent");
    expect(responseBody).not.toHaveProperty("statusAcknowledgement");
    const parsed = parseNativeRootCiCurrentTerminalProof(responseBody, {
      serviceId: "ordinary-main",
      requestId,
      generationId,
      projectId: fixture.active.claim.admission.projectId,
      reporterUsername: "ordinary-results",
      terminalEvent: result.terminalEvent
    });
    expect(parsed).toEqual({
      schemaVersion: 1,
      serviceId: "ordinary-main",
      requestId,
      servingGenerationId: generationId,
      projectId: fixture.active.claim.admission.projectId,
      repositoryId: "root",
      claimId: fixture.active.claim.claimId,
      resultGenerationId: generationId,
      serviceEpochId: fixture.active.claim.serviceEpochId,
      admissionGeneration: fixture.active.claim.admissionGeneration,
      rootSequence: fixture.active.claim.admission.rootSequence,
      rootCommit: fixture.active.claim.admission.rootCommit,
      rootTree: fixture.active.claim.admission.rootTree,
      cleanupResourceId: fixture.active.claim.claimId,
      cleanupComplete: true,
      terminalEventDigest: nativeRootCiTerminalEventDigest(result.terminalEvent),
      statusAcknowledgementJson: acknowledgement.json,
      statusAcknowledgementDigest: acknowledgement.digest,
      deliveredAt: acknowledgement.deliveredAt
    });
    expect(proofRows(restarted.database)).toEqual(before);
  }, 30_000);

  it("distinguishes authentication, hidden selectors, stale state, malformed input, and inactive activation", async () => {
    // Given
    const fixture = await deliveredFixture("installed-current-terminal-rejections", "802");
    const result = resultRequest(fixture.active.claim, fixture.active.issuance, "902");
    expect((await post(fixture.service.origin, "/v1/host-results", hostAuthorization("host-a"), result)).status).toBe(202);
    await waitFor(() => terminalState(fixture.service.database).outbox === "delivered");
    const before = proofRows(fixture.service.database);
    const body = proofBody(result.terminalEvent);

    // When
    const unknown = await proof(fixture.service.origin, "project-a",
      `Basic ${Buffer.from("unknown:unknown").toString("base64")}`, body);
    const wrongRoles = await Promise.all([
      hostAuthorization("host-a"),
      basic("native-events", bundleSecrets.webhook),
      basic("ordinary-registrar", bundleSecrets.registrar),
      basic("ordinary-identity", bundleSecrets.nativeIdentity),
      basic("ordinary-attempts", bundleSecrets.attemptIssuer),
      basic("ordinary-results", bundleSecrets.resultReporter)
    ].map((authorization) => proof(fixture.service.origin, "project-a", authorization, body)));
    const foreignProject = await proof(fixture.service.origin, "project-b", queryAuthorization(), body);
    const foreignHost = await proof(fixture.service.origin, "project-a", queryAuthorization(), proofBody({
      ...result.terminalEvent, payload: { ...result.terminalEvent.payload, hostId: "host-b" }
    }));
    const foreignAttempt = await proof(fixture.service.origin, "project-a", queryAuthorization(), proofBody({
      ...result.terminalEvent, payload: { ...result.terminalEvent.payload, attemptId: randomUUID() }
    }));
    const staleGeneration = await proof(fixture.service.origin, "project-a", queryAuthorization(), {
      ...body, requestId: randomUUID(), generationId: "f".repeat(64)
    });
    const malformed = await proof(fixture.service.origin, "project-a", queryAuthorization(), { ...body, extra: true });
    expect(proofRows(fixture.service.database)).toEqual(before);
    const database = new DatabaseSync(fixture.service.database);
    database.prepare("UPDATE native_root_admissions SET state = 'revoked'").run();
    const staleAdmission = await proof(fixture.service.origin, "project-a", queryAuthorization(), proofBody(result.terminalEvent));
    database.prepare("UPDATE native_root_admissions SET state = 'active', root_sequence = root_sequence + 1").run();
    const staleRoot = await proof(fixture.service.origin, "project-a", queryAuthorization(), proofBody(result.terminalEvent));
    database.prepare("UPDATE bundle_activation SET activation_token_sha256 = ?").run("0".repeat(64));
    const inactive = await proof(fixture.service.origin, "project-a", queryAuthorization(), proofBody(result.terminalEvent));
    database.close();

    // Then
    expect(wrongRoles.map((response) => response.status)).toEqual([403, 403, 403, 403, 403, 403]);
    expect([unknown.status, foreignProject.status, foreignHost.status, foreignAttempt.status,
      staleGeneration.status, malformed.status, staleAdmission.status, staleRoot.status, inactive.status])
      .toEqual([401, 404, 404, 404, 409, 400, 409, 409, 503]);
  }, 30_000);

  it("rejects pending, recovering, and denied delivery states without proof writes", async () => {
    // Given
    const fixture = await reservationFixture("installed-current-terminal-states");
    fixtures.push(fixture);
    const active = await activeAttempt(fixture, "803");
    const result = resultRequest(active.claim, active.issuance, "903");
    expect((await post(fixture.origin, "/v1/host-results", hostAuthorization("host-a"), result)).status).toBe(202);
    const body = proofBody(result.terminalEvent);

    // When
    const pendingBefore = proofRows(fixture.database);
    const pending = await proof(fixture.origin, "project-a", queryAuthorization(), body);
    expect(proofRows(fixture.database)).toEqual(pendingBefore);
    const database = new DatabaseSync(fixture.database);
    database.prepare("UPDATE native_root_ci_claims SET state = 'recovering'").run();
    database.prepare("UPDATE native_root_ci_claim_receipts SET state = 'recovering', recovery_request_id = ?")
      .run(randomUUID());
    database.close();
    const recoveringBefore = proofRows(fixture.database);
    const recovering = await proof(fixture.origin, "project-a", queryAuthorization(), proofBody(result.terminalEvent));
    expect(proofRows(fixture.database)).toEqual(recoveringBefore);
    const recovered = await reservationFixture("installed-current-terminal-denied");
    fixtures.push(recovered);
    const deniedActive = await activeAttempt(recovered, "804");
    const deniedResult = resultRequest(deniedActive.claim, deniedActive.issuance, "904");
    expect((await post(recovered.origin, "/v1/host-results", hostAuthorization("host-a"), deniedResult)).status).toBe(202);
    const recovery = await post(recovered.origin, "/v1/host-recoveries", hostAuthorization("host-a"), {
      schemaVersion: 1, requestId: randomUUID(), generationId, hostId: deniedActive.claim.hostId,
      capacity: deniedActive.claim.capacity, claimId: deniedActive.claim.claimId,
      attemptId: deniedActive.issuance.attemptId, descriptorDigest: deniedActive.issuance.descriptorDigest,
      claim: deniedActive.claim, issuance: deniedActive.issuance, resourceId: deniedActive.claim.claimId,
      cleanupComplete: true
    });
    expect(recovery.status).toBe(204);
    const deniedBefore = proofRows(recovered.database);
    const denied = await proof(recovered.origin, "project-a", queryAuthorization(), proofBody(deniedResult.terminalEvent));

    // Then
    expect([pending.status, recovering.status, denied.status]).toEqual([409, 409, 409]);
    expect(proofRows(recovered.database)).toEqual(deniedBefore);
  }, 30_000);

  it("fails closed for tampered result, outbox, and reporter acknowledgement", async () => {
    // Given
    const cases = ["result", "outbox", "reporter"] as const;
    const statuses: number[] = [];

    // When
    for (const [index, kind] of cases.entries()) {
      const fixture = await deliveredFixture(`installed-current-terminal-${kind}-tamper`, `81${index}`);
      const result = resultRequest(fixture.active.claim, fixture.active.issuance, `91${index}`);
      expect((await post(fixture.service.origin, "/v1/host-results", hostAuthorization("host-a"), result)).status).toBe(202);
      await waitFor(() => terminalState(fixture.service.database).outbox === "delivered");
      const database = new DatabaseSync(fixture.service.database);
      if (kind === "result") {
        database.exec("DROP TRIGGER native_root_ci_host_results_no_update");
        database.prepare("UPDATE native_root_ci_host_results SET terminal_event_json = ?").run("{}");
      } else if (kind === "outbox") {
        database.prepare("UPDATE native_root_ci_report_outbox SET terminal_event_json = ?").run("{}");
      } else {
        const row = database.prepare("SELECT acknowledgement_json FROM native_root_ci_report_outbox").get();
        const acknowledgement = JSON.parse(String(row?.acknowledgement_json));
        acknowledgement.reporterUsername = "ordinary-query";
        database.prepare("UPDATE native_root_ci_report_outbox SET acknowledgement_json = ?")
          .run(JSON.stringify(acknowledgement));
      }
      database.close();
      const before = proofRows(fixture.service.database);
      statuses.push((await proof(fixture.service.origin, "project-a", queryAuthorization(),
        proofBody(result.terminalEvent))).status);
      expect(proofRows(fixture.service.database)).toEqual(before);
    }

    // Then
    expect(statuses).toEqual([409, 409, 409]);
  }, 40_000);
});

async function deliveredFixture(label: string, suffix: string) {
  const service = await reservationFixture(label, Date.now, (nativeOrigin) => {
    const transport = createNodeNativeGitAdmissionHttpClient();
    return { request: (input) => transport.request({ ...input, endpoint: nativeOrigin }) };
  });
  fixtures.push(service);
  return { service, active: await activeAttempt(service, suffix) };
}

function proofBody(terminalEvent: Readonly<Record<string, unknown>>, requestId = randomUUID()) {
  return { schemaVersion: 1, requestId, generationId, terminalEvent } as const;
}

function proof(origin: string, projectId: string, authorization: string, body: object): Promise<Response> {
  return fetch(`${origin}/v1/projects/${projectId}/repositories/root/native-root-ci-result-proof/current-terminal`, {
    method: "POST", headers: { authorization, "content-type": "application/json" }, body: JSON.stringify(body)
  });
}

function basic(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

function proofRows(file: string): Readonly<Record<string, unknown>> {
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    return {
      activation: database.prepare("SELECT * FROM bundle_activation").all(),
      admissions: database.prepare("SELECT * FROM native_root_admissions").all(),
      demands: database.prepare("SELECT * FROM native_root_ci_demands").all(),
      claims: database.prepare("SELECT * FROM native_root_ci_claims").all(),
      receipts: database.prepare("SELECT * FROM native_root_ci_claim_receipts").all(),
      results: database.prepare("SELECT * FROM native_root_ci_host_results").all(),
      outbox: database.prepare("SELECT * FROM native_root_ci_report_outbox").all()
    };
  } finally { database.close(); }
}

function terminalState(file: string): { readonly outbox: string } {
  const database = new DatabaseSync(file, { readOnly: true });
  try { return { outbox: String(database.prepare("SELECT state FROM native_root_ci_report_outbox").get()?.state) }; }
  finally { database.close(); }
}

function acknowledgementAt(file: string): {
  readonly json: string;
  readonly value: unknown;
  readonly digest: string;
  readonly deliveredAt: number;
} {
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    const row = database.prepare(`SELECT acknowledgement_json, acknowledgement_digest, delivered_at
      FROM native_root_ci_report_outbox`).get();
    if (typeof row?.acknowledgement_json !== "string" || typeof row.acknowledgement_digest !== "string"
      || typeof row.delivered_at !== "number") throw new TypeError("delivered acknowledgement is unavailable");
    return { json: row.acknowledgement_json, value: JSON.parse(row.acknowledgement_json),
      digest: row.acknowledgement_digest, deliveredAt: row.delivered_at };
  } finally { database.close(); }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("condition was not observed");
}
