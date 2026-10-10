import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  nativeRootAdmissionBindingDigest,
  type NativeRootAdmission,
  type NativeRootAdmissionOperation
} from "./nativeRootAdmissionModel.js";
import { parseNativeRootCiPolicyProof, type NativeRootCiPolicyProof } from "./nativeRootCiProofModel.js";

const requestLimit = 100_000;

export type NativeRootAdmissionStoreContext = {
  readonly ordinaryServiceId: string;
  readonly controlPlaneGenerationId: string;
  readonly capacityConfigDigest: string;
  readonly leaseMilliseconds: number;
  readonly now: () => number;
};
export type StoredAdmissionResponse = { readonly status: number; readonly body: unknown };
export type NativeRootAdmissionRequest<Operation extends NativeRootAdmissionOperation = NativeRootAdmissionOperation> = {
  readonly requestId: string;
  readonly operation: Operation;
  readonly tupleDigest: string;
  readonly responseBody: (admission: NativeRootAdmission) => unknown;
};
export type ReplayResult = { readonly kind: "none" } | { readonly kind: "conflict" }
  | { readonly kind: "replay"; readonly response: StoredAdmissionResponse };
export type RegistrationResult = { readonly kind: "registered"; readonly admission: NativeRootAdmission }
  | { readonly kind: "conflict" };
export type AdmissionRequestResult = { readonly kind: "committed" | "replay"; readonly response: StoredAdmissionResponse }
  | { readonly kind: "request-conflict" | "capacity-full" | "operation-conflict" | "not-found" };

export class NativeRootAdmissionStore {
  constructor(readonly database: DatabaseSync, readonly context: NativeRootAdmissionStoreContext) {}

  activate(): void {
    const now = this.context.now();
    this.database.prepare(`UPDATE native_root_admissions SET state = 'replaced', ended_at = ?
      WHERE state = 'active' AND (control_plane_generation_id <> ? OR capacity_config_digest <> ?)`)
      .run(now, this.context.controlPlaneGenerationId, this.context.capacityConfigDigest);
  }

  replay(requestId: string, operation: NativeRootAdmissionOperation, tupleDigest: string): ReplayResult {
    const row = record(this.database.prepare(`SELECT operation, tuple_digest, status_code, response_json
      FROM native_root_admission_requests WHERE request_id = ?`).get(requestId));
    if (row === undefined) return { kind: "none" };
    if (row.operation !== operation || row.tuple_digest !== tupleDigest) return { kind: "conflict" };
    if (typeof row.status_code !== "number" || typeof row.response_json !== "string") corrupted();
    return { kind: "replay", response: { status: row.status_code, body: JSON.parse(row.response_json) } };
  }

  hasRequestCapacity(): boolean {
    return scalar(this.database.prepare("SELECT COUNT(*) AS value FROM native_root_admission_requests").get()) < requestLimit;
  }

  commitRegistration(input: {
    readonly request: NativeRootAdmissionRequest<"register">;
    readonly proof: NativeRootCiPolicyProof;
  }): AdmissionRequestResult {
    return this.commitRequest(input.request, () => {
      const result = this.registerMutation(input.proof);
      return result.kind === "conflict" ? { kind: "operation-conflict" } : { kind: "success", admission: result.admission };
    });
  }

  commitExisting(input: {
    readonly request: NativeRootAdmissionRequest<"current" | "revoke">;
    readonly projectId: string;
    readonly admissionGeneration: string;
  }): AdmissionRequestResult {
    return this.commitRequest(input.request, () => {
      const admission = input.request.operation === "current"
        ? this.current(input.projectId, input.admissionGeneration)
        : this.revokeMutation(input.projectId, input.admissionGeneration);
      return admission === undefined ? { kind: "not-found" } : { kind: "success", admission };
    });
  }

  register(proof: NativeRootCiPolicyProof): RegistrationResult {
    return this.transaction(() => this.registerMutation(proof));
  }

  private registerMutation(proof: NativeRootCiPolicyProof): RegistrationResult {
    const now = this.context.now();
    const expiresAt = now + this.context.leaseMilliseconds;
    const bindingDigest = nativeRootAdmissionBindingDigest({ ordinaryServiceId: this.context.ordinaryServiceId,
      controlPlaneGenerationId: this.context.controlPlaneGenerationId, nativeServiceId: proof.serviceId,
      projectId: proof.projectId, importNonce: proof.currentRoot.importNonce,
      protectedRef: proof.currentRoot.protectedRef, policyDigest: proof.currentRoot.policyDigest,
      policy: proof.policy, capacityConfigDigest: this.context.capacityConfigDigest });
    this.expire(now);
    const active = record(this.database.prepare(`SELECT * FROM native_root_admissions
      WHERE project_id = ? AND repository_id = 'root' AND state = 'active'`).get(proof.projectId));
    if (active !== undefined && active.binding_digest === bindingDigest) {
      const sequence = numberField(active, "root_sequence");
      const sameHead = active.root_commit === proof.currentRoot.commit && active.root_tree === proof.currentRoot.tree;
      if (proof.currentRoot.sequence < sequence || proof.currentRoot.sequence === sequence && !sameHead) {
        return { kind: "conflict" };
      }
      this.database.prepare(`UPDATE native_root_admissions SET root_sequence = ?, root_commit = ?, root_tree = ?,
        lease_expires_at = ?, refreshed_at = ? WHERE admission_generation = ?`).run(proof.currentRoot.sequence,
        proof.currentRoot.commit, proof.currentRoot.tree, expiresAt, now, textField(active, "admission_generation"));
      return { kind: "registered", admission: admissionFromProof({
        generation: textField(active, "admission_generation"), expiresAt,
        capacityConfigDigest: this.context.capacityConfigDigest, proof }) };
    }
    if (active !== undefined) this.database.prepare(`UPDATE native_root_admissions
      SET state = 'replaced', ended_at = ? WHERE admission_generation = ?`)
      .run(now, textField(active, "admission_generation"));
    const admissionGeneration = randomUUID();
    this.database.prepare(`INSERT INTO native_root_admissions (admission_generation, binding_digest,
      ordinary_service_id, control_plane_generation_id, native_service_id, project_id, repository_id,
      import_nonce, root_sequence, protected_ref, root_commit, root_tree, policy_digest, policy_json,
      capacity_config_digest, lease_expires_at, state, created_at, refreshed_at, ended_at)
      VALUES (?, ?, ?, ?, ?, ?, 'root', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL)`)
      .run(admissionGeneration, bindingDigest, this.context.ordinaryServiceId,
        this.context.controlPlaneGenerationId, proof.serviceId, proof.projectId, proof.currentRoot.importNonce,
        proof.currentRoot.sequence, proof.currentRoot.protectedRef, proof.currentRoot.commit,
        proof.currentRoot.tree, proof.currentRoot.policyDigest, JSON.stringify(proof.policy),
        this.context.capacityConfigDigest, expiresAt, now, now);
    return { kind: "registered", admission: admissionFromProof({
      generation: admissionGeneration, expiresAt, capacityConfigDigest: this.context.capacityConfigDigest, proof }) };
  }

  current(projectId: string, admissionGeneration: string): NativeRootAdmission | undefined {
    this.expire(this.context.now());
    const row = record(this.database.prepare(`SELECT * FROM native_root_admissions WHERE project_id = ?
      AND repository_id = 'root' AND admission_generation = ? AND state = 'active'
      AND control_plane_generation_id = ? AND capacity_config_digest = ?`).get(projectId, admissionGeneration,
      this.context.controlPlaneGenerationId, this.context.capacityConfigDigest));
    return row === undefined ? undefined : admissionFromRow(row);
  }

  discover(projectId: string): NativeRootAdmission | undefined {
    const row = record(this.database.prepare(`SELECT * FROM native_root_admissions WHERE project_id = ?
      AND repository_id = 'root' AND state = 'active' AND lease_expires_at > ?
      AND control_plane_generation_id = ? AND capacity_config_digest = ?`)
      .get(projectId, this.context.now(), this.context.controlPlaneGenerationId, this.context.capacityConfigDigest));
    return row === undefined ? undefined : admissionFromRow(row);
  }

  revoke(projectId: string, admissionGeneration: string): NativeRootAdmission | undefined {
    return this.transaction(() => this.revokeMutation(projectId, admissionGeneration));
  }

  private revokeMutation(projectId: string, admissionGeneration: string): NativeRootAdmission | undefined {
    const admission = this.current(projectId, admissionGeneration);
    if (admission === undefined) return undefined;
    this.database.prepare(`UPDATE native_root_admissions SET state = 'revoked', ended_at = ?
      WHERE admission_generation = ?`).run(this.context.now(), admissionGeneration);
    return admission;
  }

  private commitRequest(request: NativeRootAdmissionRequest,
    mutate: () => RequestMutationResult): AdmissionRequestResult {
    return this.transaction(() => {
      const replay = this.replay(request.requestId, request.operation, request.tupleDigest);
      switch (replay.kind) {
        case "conflict": return { kind: "request-conflict" };
        case "replay": return { kind: "replay", response: replay.response };
        case "none": break;
        default: return assertNever(replay);
      }
      if (!this.hasRequestCapacity()) return { kind: "capacity-full" };
      const mutation = mutate();
      if (mutation.kind !== "success") return mutation;
      const response: StoredAdmissionResponse = { status: 200, body: request.responseBody(mutation.admission) };
      this.database.prepare(`INSERT INTO native_root_admission_requests
        (request_id, operation, tuple_digest, status_code, response_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(request.requestId, request.operation, request.tupleDigest, response.status,
          JSON.stringify(response.body), this.context.now());
      return { kind: "committed", response };
    });
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

  private expire(now: number): void {
    this.database.prepare(`UPDATE native_root_admissions SET state = 'expired', ended_at = ?
      WHERE state = 'active' AND lease_expires_at <= ?`).run(now, now);
  }
}

type RequestMutationResult = { readonly kind: "success"; readonly admission: NativeRootAdmission }
  | { readonly kind: "operation-conflict" | "not-found" };

function admissionFromProof(input: { readonly generation: string; readonly expiresAt: number;
  readonly capacityConfigDigest: string; readonly proof: NativeRootCiPolicyProof }): NativeRootAdmission {
  return { schemaVersion: 1, admissionGeneration: input.generation,
    capacityConfigDigest: input.capacityConfigDigest, expiresAt: input.expiresAt,
    importedRoot: { serviceId: input.proof.serviceId, servingGenerationId: input.proof.servingGenerationId,
      projectId: input.proof.projectId, repositoryId: "root", currentRoot: input.proof.currentRoot,
      policy: input.proof.policy } };
}

function admissionFromRow(row: Readonly<Record<string, unknown>>): NativeRootAdmission {
  const projectId = textField(row, "project_id");
  const servingGenerationId = textField(row, "control_plane_generation_id");
  const proof = parseNativeRootCiPolicyProof({ schemaVersion: 1, serviceId: textField(row, "native_service_id"),
    requestId: "00000000-0000-4000-8000-000000000000", servingGenerationId, projectId,
    repositoryId: "root", currentRoot: { importNonce: textField(row, "import_nonce"),
      sequence: numberField(row, "root_sequence"), protectedRef: textField(row, "protected_ref"),
      commit: textField(row, "root_commit"), tree: textField(row, "root_tree"),
      policyDigest: textField(row, "policy_digest") }, policy: JSON.parse(textField(row, "policy_json")) },
  { serviceId: "native-main", generationId: servingGenerationId,
    requestId: "00000000-0000-4000-8000-000000000000", projectId });
  return admissionFromProof({ generation: textField(row, "admission_generation"),
    expiresAt: numberField(row, "lease_expires_at"),
    capacityConfigDigest: textField(row, "capacity_config_digest"), proof });
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).map((key) => [key, Reflect.get(value, key)])) : undefined;
}
function textField(row: Readonly<Record<string, unknown>>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") corrupted();
  return value;
}
function numberField(row: Readonly<Record<string, unknown>>, key: string): number {
  const value = row[key];
  if (typeof value !== "number") corrupted();
  return value;
}
function scalar(value: unknown): number {
  const row = record(value);
  return row === undefined ? corrupted() : numberField(row, "value");
}
function corrupted(): never { throw new NativeRootAdmissionStoreError(); }
function assertNever(value: never): never { throw new TypeError(`unexpected replay result: ${JSON.stringify(value)}`); }
export class NativeRootAdmissionStoreError extends Error { readonly name = "NativeRootAdmissionStoreError"; }
