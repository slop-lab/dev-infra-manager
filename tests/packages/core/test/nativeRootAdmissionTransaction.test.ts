import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeNativeGitAdmissionHttpClient } from "../../../../core/packages/core/src/nativeGitAdmissionHttpClient.js";
import type {
  NativeGitAdmissionHttpRequest,
  NativeGitAdmissionHttpResponse
} from "../../../../core/packages/core/src/nativeGitAdmissionSource.js";
import { parseNativeOrdinaryBundleConfig } from "../../../../core/packages/core/src/nativeOrdinaryBundleConfig.js";
import { configuredNativeRootAdmissionServer } from "../../../../core/packages/core/src/nativeRootAdmissionService.js";
import type { NativeRootCiProofHttpClient } from "../../../../core/packages/core/src/nativeRootCiProofClient.js";
import { bundleSecrets, idleOrdinaryConfig } from "../../native-git/test/bundleConfigFixture.js";
import { createBundleReview, nativeBundleReviewFixture } from "../../native-git/test/nativeBundleReviewFixture.js";
import { cleanupFinalizeFixtures, generationId } from "../../native-git/test/nativeRootImportFinalizeFixture.js";

const readinessToken = Buffer.alloc(32, 41).toString("base64url");
const activationToken = Buffer.alloc(32, 42).toString("base64url");
const roots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(close));
  await cleanupFinalizeFixtures();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("native root admission request transactions", () => {
  it("replays concurrent exact request IDs after proof and mutates once", async () => {
    // Given
    const fixture = await setup("ordinary-root-admission-exact-overlap");
    fixture.proofGate.block();
    mutateDatabase(fixture.root, (database) => database.exec(`
      CREATE TABLE admission_mutations(value INTEGER NOT NULL);
      CREATE TRIGGER audit_admission_insert AFTER INSERT ON native_root_admissions
        BEGIN INSERT INTO admission_mutations VALUES (1); END;
      CREATE TRIGGER audit_admission_update AFTER UPDATE ON native_root_admissions
        BEGIN INSERT INTO admission_mutations VALUES (1); END;`));
    const request = requestBody();

    // When
    const first = call(fixture.origin, "register", request);
    const second = call(fixture.origin, "register", request);
    await fixture.proofGate.waitFor(2);
    fixture.proofGate.releaseAll();
    const responses = await Promise.all([first, second]);

    // Then
    expect(responses[0]).toEqual(responses[1]);
    expect(responses[0]?.status).toBe(200);
    expect(admissionRows(fixture.root)).toHaveLength(1);
    expect(scalar(fixture.root, "SELECT COUNT(*) AS value FROM admission_mutations")).toBe(1);
    expect(requestCount(fixture.root)).toBe(1);
  });

  it("rejects a changed tuple that loses a request-ID race without loser mutation", async () => {
    // Given
    const fixture = await setup("ordinary-root-admission-conflict-overlap");
    const registered = await call(fixture.origin, "register", requestBody());
    const admissionGeneration = admissionField(registered, "admissionGeneration");
    const requestId = randomUUID();
    fixture.proofGate.block();

    // When
    const pendingRegister = call(fixture.origin, "register", { schemaVersion: 1, requestId, generationId });
    await fixture.proofGate.waitFor(1);
    const revoke = await call(fixture.origin, "revoke",
      { schemaVersion: 1, requestId, generationId, admissionGeneration });
    fixture.proofGate.releaseAll();
    const register = await pendingRegister;

    // Then
    expect(revoke.status).toBe(200);
    expect(register.status).toBe(409);
    expect(admissionRows(fixture.root)).toEqual([{ generation: admissionGeneration, state: "revoked" }]);
    expect(requestCount(fixture.root)).toBe(2);
  });

  it("rolls registration back when its replay receipt cannot be inserted", async () => {
    // Given
    const fixture = await setup("ordinary-root-admission-registration-rollback");
    rejectReceipts(fixture.root);

    // When
    const result = await call(fixture.origin, "register", requestBody());

    // Then
    expect(result.status).toBe(500);
    expect(admissionRows(fixture.root)).toEqual([]);
    expect(requestCount(fixture.root)).toBe(0);
  });

  it("rolls revocation back when its replay receipt cannot be inserted", async () => {
    // Given
    const fixture = await setup("ordinary-root-admission-revocation-rollback");
    const registered = await call(fixture.origin, "register", requestBody());
    const admissionGeneration = admissionField(registered, "admissionGeneration");
    rejectReceipts(fixture.root);

    // When
    const result = await call(fixture.origin, "revoke", { ...requestBody(), admissionGeneration });

    // Then
    expect(result.status).toBe(500);
    expect(admissionRows(fixture.root)).toEqual([{ generation: admissionGeneration, state: "active" }]);
    expect(requestCount(fixture.root)).toBe(1);
  });

  it("does not mutate when replay capacity fills while policy proof is pending", async () => {
    // Given
    const fixture = await setup("ordinary-root-admission-cap-overlap");
    fixture.proofGate.block();

    // When
    const pending = call(fixture.origin, "register", requestBody());
    await fixture.proofGate.waitFor(1);
    mutateDatabase(fixture.root, (database) => database.exec(`WITH RECURSIVE requests(value) AS (
      SELECT 1 UNION ALL SELECT value + 1 FROM requests WHERE value < 100000
    ) INSERT INTO native_root_admission_requests
      (request_id, operation, tuple_digest, status_code, response_json, created_at)
      SELECT printf('%032x', value), 'current', printf('%064x', value), 200, '{}', 1 FROM requests`));
    fixture.proofGate.releaseAll();
    const result = await pending;

    // Then
    expect(result.status).toBe(429);
    expect(admissionRows(fixture.root)).toEqual([]);
    expect(requestCount(fixture.root)).toBe(100_000);
  });
});

async function setup(label: string): Promise<Fixture> {
  const native = await nativeBundleReviewFixture(label);
  await createBundleReview(native.service);
  const root = await mkdtemp(join(tmpdir(), "dim-native-root-admission-transaction-"));
  roots.push(root);
  const proofGate = new PolicyProofGate(native.service.origin);
  const server = await configuredNativeRootAdmissionServer({ config: parseNativeOrdinaryBundleConfig(idleOrdinaryConfig()),
    stateDirectory: join(root, "ordinary"), readinessToken, activationToken, expectedGenerationId: generationId,
    proofHttpClient: proofGate });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new TypeError("ordinary listener is unavailable");
  const origin = `http://127.0.0.1:${address.port}`;
  await request(origin, "/v1/activation", `Bearer ${activationToken}`, { schemaVersion: 1, generationId });
  return { root, origin, proofGate };
}

function call(origin: string, operation: "register" | "revoke", body: object): Promise<HttpResult> {
  return request(origin, `/v1/projects/project-a/repositories/root/native-root-admission/${operation}`,
    `Basic ${Buffer.from(`ordinary-registrar:${bundleSecrets.registrar}`).toString("base64")}`, body);
}
async function request(origin: string, path: string, authorization: string, body: object): Promise<HttpResult> {
  const response = await fetch(`${origin}${path}`, { method: "POST",
    headers: { authorization, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}
function requestBody() { return { schemaVersion: 1, requestId: randomUUID(), generationId } as const; }
function admissionField(result: HttpResult, field: string): string {
  if (typeof result.body !== "object" || result.body === null) throw new TypeError("response is invalid");
  const admission = Reflect.get(result.body, "admission");
  if (typeof admission !== "object" || admission === null) throw new TypeError("admission is invalid");
  const value = Reflect.get(admission, field);
  if (typeof value !== "string") throw new TypeError("admission field is invalid");
  return value;
}
function rejectReceipts(root: string): void {
  mutateDatabase(root, (database) => database.exec(`CREATE TRIGGER reject_admission_receipt
    BEFORE INSERT ON native_root_admission_requests BEGIN SELECT RAISE(ABORT, 'receipt rejected'); END`));
}
function mutateDatabase(root: string, mutate: (database: DatabaseSync) => void): void {
  const database = new DatabaseSync(join(root, "ordinary", "ordinary-ci.sqlite3"));
  try { mutate(database); } finally { database.close(); }
}
function admissionRows(root: string): readonly { readonly generation: string; readonly state: string }[] {
  const database = new DatabaseSync(join(root, "ordinary", "ordinary-ci.sqlite3"), { readOnly: true });
  const rows = database.prepare("SELECT admission_generation, state FROM native_root_admissions ORDER BY created_at").all()
    .map((row) => ({ generation: String(row.admission_generation), state: String(row.state) }));
  database.close();
  return rows;
}
function requestCount(root: string): number {
  return scalar(root, "SELECT COUNT(*) AS value FROM native_root_admission_requests");
}
function scalar(root: string, sql: string): number {
  const database = new DatabaseSync(join(root, "ordinary", "ordinary-ci.sqlite3"), { readOnly: true });
  const row = database.prepare(sql).get();
  database.close();
  return Number(row?.value);
}
async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
}

class PolicyProofGate implements NativeRootCiProofHttpClient {
  readonly #client = createNodeNativeGitAdmissionHttpClient();
  readonly #held: { readonly input: NativeGitAdmissionHttpRequest;
    readonly resolve: (response: NativeGitAdmissionHttpResponse) => void; readonly reject: (error: unknown) => void }[] = [];
  readonly #waiters: { readonly count: number; readonly resolve: () => void }[] = [];
  #blocked = false;
  constructor(readonly origin: string) {}
  block(): void { this.#blocked = true; }
  request(input: NativeGitAdmissionHttpRequest): Promise<NativeGitAdmissionHttpResponse> {
    if (!this.#blocked || !input.path.endsWith("/native-root-ci-proof/policy")) {
      return this.#client.request({ ...input, endpoint: this.origin });
    }
    return new Promise((resolve, reject) => { this.#held.push({ input, resolve, reject }); this.#notify(); });
  }
  waitFor(count: number): Promise<void> {
    return this.#held.length >= count ? Promise.resolve()
      : new Promise((resolve) => this.#waiters.push({ count, resolve }));
  }
  releaseAll(): void {
    this.#blocked = false;
    for (const held of this.#held.splice(0)) {
      void this.#client.request({ ...held.input, endpoint: this.origin }).then(held.resolve, held.reject);
    }
  }
  #notify(): void {
    for (let index = this.#waiters.length - 1; index >= 0; index -= 1) {
      const waiter = this.#waiters[index];
      if (waiter !== undefined && this.#held.length >= waiter.count) {
        this.#waiters.splice(index, 1);
        waiter.resolve();
      }
    }
  }
}

type Fixture = { readonly root: string; readonly origin: string; readonly proofGate: PolicyProofGate };
type HttpResult = { readonly status: number; readonly body: unknown };
