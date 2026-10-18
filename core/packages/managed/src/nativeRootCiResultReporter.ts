import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import type { NativeGitAdmissionHttpClient, NativeGitAdmissionHttpResponse } from "./nativeGitAdmissionSource.js";
import type { NativeOrdinaryAuthorityConfig } from "./nativeOrdinaryAuthorityConfig.js";
import {
  nativeRootCiTerminalEventDigest,
  parseNativeRootCiStatusAcknowledgement,
  parseNativeRootCiTerminalEvent,
  type NativeRootCiTerminalEvent
} from "./nativeRootCiResultProtocol.js";

const requestTimeoutMilliseconds = 5_000;

type Delivery = {
  readonly claimId: string;
  readonly terminalEventJson: string;
};

export class NativeRootCiResultReporter {
  readonly #database: DatabaseSync;
  readonly #config: NativeOrdinaryAuthorityConfig;
  readonly #httpClient: NativeGitAdmissionHttpClient;
  readonly #active: () => boolean;
  readonly #generationId: string;
  readonly #now: () => number;
  readonly #controller = new AbortController();
  readonly #worker: Promise<void>;
  #healthy = true;

  constructor(input: {
    readonly database: DatabaseSync;
    readonly config: NativeOrdinaryAuthorityConfig;
    readonly httpClient: NativeGitAdmissionHttpClient;
    readonly active: () => boolean;
    readonly generationId: string;
    readonly now: () => number;
  }) {
    this.#database = input.database;
    this.#config = input.config;
    this.#httpClient = input.httpClient;
    this.#active = input.active;
    this.#generationId = input.generationId;
    this.#now = input.now;
    this.#worker = this.#run();
  }

  async close(): Promise<void> {
    this.#controller.abort();
    await this.#worker;
  }

  get healthy(): boolean {
    return this.#healthy;
  }

  async #run(): Promise<void> {
    let failedAttempts = 0;
    while (!this.#controller.signal.aborted) {
      let delivery: Delivery | undefined;
      try {
        delivery = this.#takeOldest();
      } catch {
        this.#healthy = false;
        return;
      }
      if (delivery === undefined) {
        failedAttempts = 0;
        try {
          await delay(100, undefined, { signal: this.#controller.signal });
        } catch (error) {
          if (error instanceof Error && error.name === "AbortError") return;
          throw error;
        }
        continue;
      }
      try {
        const acknowledgementJson = await this.#send(delivery);
        this.#acknowledge(delivery, acknowledgementJson);
        failedAttempts = 0;
      } catch (error) {
        if (!(error instanceof NativeRootCiResultReporterUnavailableError)) throw error;
        if (this.#controller.signal.aborted) return;
        failedAttempts += 1;
        const retryDelay = Math.min(30_000, 1_000 * (2 ** Math.min(failedAttempts - 1, 5)));
        try {
          await delay(retryDelay, undefined, { signal: this.#controller.signal });
        } catch (delayError) {
          if (delayError instanceof Error && delayError.name === "AbortError") return;
          throw delayError;
        }
      }
    }
  }

  #takeOldest(): Delivery | undefined {
      if (!this.#active()) return undefined;
      const row = this.#database.prepare(`SELECT o.claim_id, o.terminal_event_json,
          o.terminal_event_digest
        FROM native_root_ci_report_outbox o
        JOIN native_root_ci_host_results h ON h.claim_id = o.claim_id
        JOIN native_root_ci_claims c ON c.claim_id = h.claim_id
        JOIN native_root_ci_claim_receipts r ON r.claim_id = c.claim_id
        WHERE o.state = 'pending'
          AND h.terminal_event_json = o.terminal_event_json
          AND h.terminal_event_digest = o.terminal_event_digest
          AND c.state = 'reported' AND r.state = 'reported'
        ORDER BY o.created_at, o.claim_id LIMIT 1`).get();
      if (row === undefined) return undefined;
      const claimId = text(row, "claim_id");
      const terminalEventJson = text(row, "terminal_event_json");
      const event = parseNativeRootCiTerminalEvent(JSON.parse(terminalEventJson));
      if (text(row, "terminal_event_digest") !== nativeRootCiTerminalEventDigest(event)) {
        throw new NativeRootCiResultReporterUnavailableError();
      }
      return { claimId, terminalEventJson };
  }

  async #send(delivery: Delivery): Promise<string> {
    const event = parseNativeRootCiTerminalEvent(JSON.parse(delivery.terminalEventJson));
    let response: NativeGitAdmissionHttpResponse;
    try {
      response = await this.#httpClient.request({
        endpoint: this.#config.nativeGit.endpoint,
        method: "POST",
        path: `/v1/projects/${event.payload.descriptor.projectId}/repositories/root/reviews/${event.payload.reviewId}/statuses`,
        authorization: basicAuthorization(this.#config.nativeGit.resultReporter),
        generationId: this.#generationId,
        body: delivery.terminalEventJson,
        signal: AbortSignal.any([this.#controller.signal, AbortSignal.timeout(requestTimeoutMilliseconds)])
      });
    } catch (error) {
      throw new NativeRootCiResultReporterUnavailableError({ cause: error });
    }
    if (response.statusCode !== 201 || response.contentType !== "application/json; charset=utf-8"
      || response.cacheControl !== "no-store") throw new NativeRootCiResultReporterUnavailableError();
    const acknowledgementJson = response.body.toString("utf8");
    try {
      parseNativeRootCiStatusAcknowledgement(JSON.parse(acknowledgementJson), event,
        this.#config.nativeGit.resultReporter.username);
    } catch (error) {
      throw new NativeRootCiResultReporterUnavailableError({ cause: error });
    }
    return acknowledgementJson;
  }

  #acknowledge(delivery: Delivery, acknowledgementJson: string): void {
    const event = parseNativeRootCiTerminalEvent(JSON.parse(delivery.terminalEventJson));
    parseNativeRootCiStatusAcknowledgement(JSON.parse(acknowledgementJson), event,
      this.#config.nativeGit.resultReporter.username);
    const now = this.#now();
    const digest = `sha256:${createHash("sha256").update(acknowledgementJson, "utf8").digest("hex")}`;
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      if (!this.#active()) throw new NativeRootCiResultReporterUnavailableError();
      const row = this.#database.prepare(`SELECT c.demand_id
        FROM native_root_ci_report_outbox o
        JOIN native_root_ci_host_results h ON h.claim_id = o.claim_id
        JOIN native_root_ci_claims c ON c.claim_id = h.claim_id
        JOIN native_root_ci_claim_receipts r ON r.claim_id = c.claim_id
        JOIN native_root_ci_demands d ON d.demand_id = c.demand_id
        JOIN native_root_ci_event_receipts e
          ON e.admission_generation = d.admission_generation AND e.event_id = d.event_id
        JOIN native_root_admissions a ON a.admission_generation = c.admission_generation
        WHERE o.claim_id = ? AND o.state = 'pending' AND o.terminal_event_json = ?
          AND h.terminal_event_json = o.terminal_event_json
          AND h.terminal_event_digest = o.terminal_event_digest
          AND c.state = 'reported' AND r.state = 'reported' AND d.state = 'reported'
          AND a.state = 'active' AND a.lease_expires_at > ?
          AND a.control_plane_generation_id = c.generation_id
          AND a.capacity_config_digest = c.capacity_config_digest
          AND a.root_sequence = e.root_sequence AND a.root_commit = e.root_commit
          AND a.root_tree = e.root_tree AND a.policy_digest = e.policy_digest`)
        .get(delivery.claimId, delivery.terminalEventJson, now);
      if (row === undefined) throw new NativeRootCiResultReporterUnavailableError();
      const demandId = text(row, "demand_id");
      const update = this.#database.prepare(`UPDATE native_root_ci_report_outbox
        SET state = 'delivered', acknowledgement_json = ?, acknowledgement_digest = ?,
          delivered_at = ?
        WHERE claim_id = ? AND state = 'pending' AND terminal_event_json = ?`)
        .run(acknowledgementJson, digest, now, delivery.claimId, delivery.terminalEventJson);
      if (update.changes !== 1) throw new NativeRootCiResultReporterUnavailableError();
      if (this.#database.prepare(`UPDATE native_root_ci_claim_receipts
        SET state = 'released', updated_at = ?, released_at = ?
        WHERE claim_id = ? AND state = 'reported' AND recovery_request_id IS NULL AND revocation_json IS NULL`)
        .run(now, now, delivery.claimId).changes !== 1) throw new NativeRootCiResultReporterUnavailableError();
      if (this.#database.prepare(`UPDATE native_root_ci_claims SET state = 'released', updated_at = ?
        WHERE claim_id = ? AND state = 'reported'`).run(now, delivery.claimId).changes !== 1) {
        throw new NativeRootCiResultReporterUnavailableError();
      }
      if (this.#database.prepare(`UPDATE native_root_ci_demands
        SET state = 'completed', updated_at = ?, terminal_at = ? WHERE demand_id = ? AND state = 'reported'`)
        .run(now, now, demandId).changes !== 1) throw new NativeRootCiResultReporterUnavailableError();
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }
}

function basicAuthorization(credential: { readonly username: string; readonly password: string }): string {
  return `Basic ${Buffer.from(`${credential.username}:${credential.password}`, "utf8").toString("base64")}`;
}

function text(row: unknown, field: string): string {
  const value = typeof row === "object" && row !== null ? Reflect.get(row, field) : undefined;
  if (typeof value !== "string") throw new NativeRootCiResultReporterUnavailableError();
  return value;
}

export class NativeRootCiResultReporterUnavailableError extends Error {
  readonly name = "NativeRootCiResultReporterUnavailableError";

  constructor(options?: ErrorOptions) {
    super("native root CI result reporter is unavailable", options);
  }
}
