import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import type { NativeCapacityPolicy } from "./nativeOrdinaryAuthorityModel.js";
import {
  parseNativeRootCiClaim,
  type NativeRootCiClaim,
  type NativeRootCiClaimRequest
} from "./nativeRootCiClaimProtocol.js";
import { parseNativeRootCiReviewEvent } from "./nativeRootCiReviewEvent.js";

type ClaimStoreContext = {
  readonly serviceId: string;
  readonly generationId: string;
  readonly serviceEpochId: string;
  readonly capacityConfigDigest: string;
  readonly capacities: ReadonlyMap<string, NativeCapacityPolicy>;
  readonly now: () => number;
};

export type ClaimReservationResult =
  | { readonly kind: "created" | "replay"; readonly claim: NativeRootCiClaim }
  | { readonly kind: "empty" | "conflict" };
export type ClaimVerificationResult = "current" | "not-found" | "stale";

export class NativeRootCiClaimStore {
  constructor(readonly database: DatabaseSync, readonly context: ClaimStoreContext) {}

  activateEpoch(): void {
    const now = this.context.now();
    this.transaction(() => {
      this.database.prepare("UPDATE native_root_ci_service_epochs SET active = 0 WHERE active = 1 AND epoch_id <> ?")
        .run(this.context.serviceEpochId);
      this.database.prepare(`INSERT INTO native_root_ci_service_epochs
        (epoch_id, generation_id, started_at, active) VALUES (?, ?, ?, 1)
        ON CONFLICT(epoch_id) DO UPDATE SET active = 1`).run(
        this.context.serviceEpochId, this.context.generationId, now);
    });
  }

  ownsActiveEpoch(): boolean {
    return this.database.prepare(`SELECT 1 FROM native_root_ci_service_epochs
      WHERE epoch_id = ? AND generation_id = ? AND active = 1`).get(
      this.context.serviceEpochId, this.context.generationId) !== undefined;
  }

  reserve(request: NativeRootCiClaimRequest): ClaimReservationResult {
    return this.transaction(() => {
      if (!this.ownsActiveEpoch()) throw new NativeRootCiStaleEpochError();
      const existing = this.database.prepare(`SELECT generation_id, response_json FROM native_root_ci_claims
        WHERE host_id = ? AND capacity = ? AND request_id = ?`).get(
        request.hostId, request.capacity, request.requestId);
      if (existing !== undefined) {
        const generationId = field(existing, "generation_id");
        if (generationId !== request.generationId) return { kind: "conflict" };
        return { kind: "replay", claim: parseStoredClaim(field(existing, "response_json")) };
      }
      const capacity = this.context.capacities.get(`${request.hostId}\0${request.capacity}`);
      if (capacity === undefined) return { kind: "conflict" };
      if (this.database.prepare(`SELECT 1 FROM native_root_ci_claims
        WHERE host_id = ? AND capacity = ? AND state <> 'released'`).get(
        request.hostId, request.capacity) !== undefined) return { kind: "conflict" };
      const row = this.database.prepare(`SELECT d.demand_id, d.admission_generation, r.event_digest, r.event_json,
        a.project_id, a.import_nonce, a.root_sequence, a.protected_ref, a.root_commit, a.root_tree,
        a.policy_digest, a.capacity_config_digest, a.lease_expires_at
        FROM native_root_ci_demands d
        JOIN native_root_ci_event_receipts r
          ON r.admission_generation = d.admission_generation AND r.event_id = d.event_id
        JOIN native_root_admissions a ON a.admission_generation = d.admission_generation
        WHERE d.state = 'queued' AND a.state = 'active' AND a.lease_expires_at > ?
          AND a.ordinary_service_id = ? AND a.control_plane_generation_id = ?
          AND a.capacity_config_digest = ? AND a.root_sequence = r.root_sequence
          AND a.root_commit = r.root_commit AND a.root_tree = r.root_tree
        ORDER BY d.created_at, d.demand_id LIMIT 1`).get(
        this.context.now(), this.context.serviceId, this.context.generationId, this.context.capacityConfigDigest);
      if (row === undefined) return { kind: "empty" };
      const claim = this.claim(request, capacity, row);
      const update = this.database.prepare(`UPDATE native_root_ci_demands SET state = 'preparing', updated_at = ?
        WHERE demand_id = ? AND state = 'queued'`).run(this.context.now(), claim.demandId);
      if (update.changes !== 1) throw new NativeRootCiClaimStoreError();
      this.database.prepare(`INSERT INTO native_root_ci_claims
        (claim_id, issuance_request_id, request_id, demand_id, admission_generation, event_id,
        host_id, capacity, service_epoch_id, generation_id, capacity_config_digest, runner_base_image,
        job_base_image, bounds_json, response_json, state, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'preparing', ?, ?)`).run(
        claim.claimId, claim.issuanceRequestId, claim.requestId, claim.demandId, claim.admissionGeneration,
        claim.event.eventId, claim.hostId, claim.capacity, claim.serviceEpochId, claim.generationId,
        claim.admission.capacityConfigDigest, claim.runnerBaseImage, claim.jobBaseImage,
        JSON.stringify(claim.bounds), JSON.stringify(claim), this.context.now(), this.context.now());
      return { kind: "created", claim };
    });
  }

  verify(input: NativeRootCiClaim): ClaimVerificationResult {
    const row = this.database.prepare("SELECT response_json, service_epoch_id FROM native_root_ci_claims WHERE claim_id = ?")
      .get(input.claimId);
    if (row === undefined) return "not-found";
    const stored = parseStoredClaim(field(row, "response_json"));
    if (!isDeepStrictEqual(stored, input)) return "not-found";
    if (field(row, "service_epoch_id") !== this.context.serviceEpochId || !this.ownsActiveEpoch()) return "stale";
    const capacity = this.context.capacities.get(`${input.hostId}\0${input.capacity}`);
    if (capacity === undefined || !capacityMatches(input, capacity)) return "not-found";
    const current = this.database.prepare(`SELECT 1 FROM native_root_ci_claims c
      JOIN native_root_ci_demands d ON d.demand_id = c.demand_id
      JOIN native_root_ci_event_receipts r
        ON r.admission_generation = d.admission_generation AND r.event_id = d.event_id
      JOIN native_root_admissions a ON a.admission_generation = d.admission_generation
      WHERE c.claim_id = ? AND c.state = 'preparing' AND d.state = 'preparing'
        AND c.issuance_request_id = c.claim_id AND c.generation_id = ?
        AND c.capacity_config_digest = ? AND a.state = 'active' AND a.lease_expires_at > ?
        AND a.ordinary_service_id = ? AND a.control_plane_generation_id = ?
        AND a.capacity_config_digest = ? AND a.admission_generation = ?
        AND a.project_id = ? AND a.import_nonce = ? AND a.root_sequence = ?
        AND a.protected_ref = ? AND a.root_commit = ? AND a.root_tree = ? AND a.policy_digest = ?
        AND r.event_digest = ? AND r.event_json = ?`).get(
        input.claimId, this.context.generationId, this.context.capacityConfigDigest, this.context.now(),
        this.context.serviceId, this.context.generationId, this.context.capacityConfigDigest,
        input.admissionGeneration, input.admission.projectId, input.admission.importNonce,
        input.admission.rootSequence, input.admission.protectedRef, input.admission.rootCommit,
        input.admission.rootTree, input.admission.policyDigest, input.eventDigest, JSON.stringify(input.event));
    return current === undefined ? "not-found" : "current";
  }

  private claim(request: NativeRootCiClaimRequest, capacity: NativeCapacityPolicy, row: unknown): NativeRootCiClaim {
    const claimId = randomUUID();
    const event = parseNativeRootCiReviewEvent(JSON.parse(field(row, "event_json")));
    return {
      schemaVersion: 1,
      serviceId: this.context.serviceId,
      generationId: this.context.generationId,
      serviceEpochId: this.context.serviceEpochId,
      requestId: request.requestId,
      claimId,
      issuanceRequestId: claimId,
      demandId: field(row, "demand_id"),
      admissionGeneration: field(row, "admission_generation"),
      eventDigest: field(row, "event_digest"),
      event,
      admission: {
        projectId: field(row, "project_id"), repositoryId: "root", importNonce: field(row, "import_nonce"),
        rootSequence: numeric(row, "root_sequence"), protectedRef: field(row, "protected_ref"),
        rootCommit: field(row, "root_commit"), rootTree: field(row, "root_tree"),
        policyDigest: field(row, "policy_digest"), capacityConfigDigest: field(row, "capacity_config_digest"),
        leaseExpiresAt: numeric(row, "lease_expires_at")
      },
      hostId: capacity.hostId,
      capacity: capacity.capacity,
      runnerBaseImage: capacity.runnerBaseImage,
      jobBaseImage: capacity.jobBaseImage,
      bounds: capacity.bounds
    };
  }

  private transaction<Result>(operation: () => Result): Result {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

function capacityMatches(claim: NativeRootCiClaim, capacity: NativeCapacityPolicy): boolean {
  return claim.runnerBaseImage === capacity.runnerBaseImage && claim.jobBaseImage === capacity.jobBaseImage
    && isDeepStrictEqual(claim.bounds, capacity.bounds);
}
function parseStoredClaim(value: string): NativeRootCiClaim {
  try { return parseNativeRootCiClaim(JSON.parse(value)); }
  catch (error) { throw new NativeRootCiClaimStoreError({ cause: error }); }
}
function field(row: unknown, name: string): string {
  const value = typeof row === "object" && row !== null ? Reflect.get(row, name) : undefined;
  if (typeof value !== "string") throw new NativeRootCiClaimStoreError();
  return value;
}
function numeric(row: unknown, name: string): number {
  const value = typeof row === "object" && row !== null ? Reflect.get(row, name) : undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new NativeRootCiClaimStoreError();
  return value;
}
export class NativeRootCiStaleEpochError extends Error {
  readonly name = "NativeRootCiStaleEpochError";
  constructor() { super("native root CI service epoch is stale"); }
}
export class NativeRootCiClaimStoreError extends Error {
  readonly name = "NativeRootCiClaimStoreError";
  constructor(options?: ErrorOptions) { super("native root CI claim state is invalid", options); }
}
