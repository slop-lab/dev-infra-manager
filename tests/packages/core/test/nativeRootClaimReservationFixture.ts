import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect } from "vitest";
import { createNodeNativeGitAdmissionHttpClient } from "../../../../core/packages/core/src/nativeGitAdmissionHttpClient.js";
import type { NativeGitAdmissionHttpClient } from "../../../../core/packages/core/src/nativeGitAdmissionSource.js";
import { parseNativeOrdinaryBundleConfig } from "../../../../core/packages/core/src/nativeOrdinaryBundleConfig.js";
import { configuredNativeRootAdmissionServer } from "../../../../core/packages/core/src/nativeRootAdmissionService.js";
import { bundleSecrets, idleOrdinaryConfig } from "../../native-git/test/bundleConfigFixture.js";
import { createBundleReview, nativeBundleReviewFixture } from "../../native-git/test/nativeBundleReviewFixture.js";
import { generationId } from "../../native-git/test/nativeRootImportFinalizeFixture.js";

const readinessToken = Buffer.alloc(32, 81).toString("base64url");
const activationToken = Buffer.alloc(32, 82).toString("base64url");
const hostBToken = Buffer.alloc(32, 83).toString("base64url");

export type ReservationFixture = {
  readonly root: string;
  readonly nativeRoot: string;
  readonly database: string;
  readonly origin: string;
  readonly server: Server;
  readonly nativeServer: Server;
  readonly nativeOrigin: string;
  readonly admissionGeneration: string;
  readonly event: Readonly<Record<string, unknown>>;
  restart(options?: { readonly activate?: boolean }): Promise<ReservationFixture>;
  activate(): Promise<void>;
  close(): Promise<void>;
};

export async function reservationFixture(
  label: string,
  now: () => number = Date.now,
  ordinaryNativeClient?: (nativeOrigin: string) => NativeGitAdmissionHttpClient
): Promise<ReservationFixture> {
  const outbound = createNodeNativeGitAdmissionHttpClient();
  let ordinaryOrigin = "http://127.0.0.1:1";
  const native = await nativeBundleReviewFixture(label, undefined, undefined, undefined, {
    request: (input) => outbound.request({ ...input, endpoint: ordinaryOrigin })
  });
  const envelope = await createBundleReview(native.service);
  const event = envelope.events.find((candidate) => candidate.executionKind === "ordinary-sysbox");
  if (event === undefined) throw new TypeError("ordinary review event is missing");
  const root = await mkdtemp(join(tmpdir(), "dim-native-root-claim-"));
  const service = await start(root, native.service.origin, now, ordinaryNativeClient);
  ordinaryOrigin = service.origin;
  await activate(service.origin);
  const receipt = await post(service.origin, "/v1/native-root-ci-events", webhookAuthorization(), {
    schemaVersion: 1,
    generationId,
    event
  });
  expect(receipt.status).toBe(202);
  const admissionGeneration = eligibilityGeneration(receipt.body);
  return fixtureValue(root, native.root, native.service.server, service, admissionGeneration, event, now, ordinaryNativeClient,
    (origin) => { ordinaryOrigin = origin; });
}

function fixtureValue(
  root: string,
  nativeRoot: string,
  nativeServer: Server,
  service: RunningOrdinary,
  admissionGeneration: string,
  event: Readonly<Record<string, unknown>>,
  now: () => number,
  ordinaryNativeClient: ((nativeOrigin: string) => NativeGitAdmissionHttpClient) | undefined,
  updateOrdinaryOrigin: (origin: string) => void
): ReservationFixture {
  return {
    root,
    nativeRoot,
    database: join(root, "ordinary", "ordinary-ci.sqlite3"),
    origin: service.origin,
    server: service.server,
    nativeServer,
    nativeOrigin: nativeServerOrigin(nativeServer),
    admissionGeneration,
    event,
    async restart(options) {
      await closeServer(service.server);
      const restarted = await start(root, nativeServerOrigin(nativeServer), now, ordinaryNativeClient);
      if (options?.activate !== false) await activate(restarted.origin);
      updateOrdinaryOrigin(restarted.origin);
      return fixtureValue(root, nativeRoot, nativeServer, restarted, admissionGeneration, event, now, ordinaryNativeClient,
        updateOrdinaryOrigin);
    },
    async activate() {
      await activate(service.origin);
    },
    async close() {
      await closeServer(service.server);
      await closeServer(nativeServer);
      await rm(root, { recursive: true, force: true });
    }
  };
}

async function start(root: string, nativeOrigin: string, now: () => number,
  ordinaryNativeClient?: (nativeOrigin: string) => NativeGitAdmissionHttpClient): Promise<RunningOrdinary> {
  const client = createNodeNativeGitAdmissionHttpClient();
  const config = idleOrdinaryConfig();
  config.hosts.push({
    hostId: "host-b",
    hostToken: hostBToken,
    capacities: [{
      capacity: "backup",
      runnerBaseImage: `registry.example/dim/ordinary-runner-backup@sha256:${"e".repeat(64)}`,
      jobBaseImage: `registry.example/dim/ordinary-job-backup@sha256:${"f".repeat(64)}`,
      bounds: {
        cpu: "2",
        memoryBytes: "4294967296",
        pids: "1024",
        wallClockSeconds: "1800",
        outputBytes: "8388608"
      }
    }]
  });
  const server = await configuredNativeRootAdmissionServer({
    config: parseNativeOrdinaryBundleConfig(config),
    stateDirectory: join(root, "ordinary"),
    readinessToken,
    activationToken,
    expectedGenerationId: generationId,
    now,
    proofHttpClient: ordinaryNativeClient?.(nativeOrigin)
      ?? { request: (input) => input.path.endsWith("/statuses")
        ? Promise.reject(new Error("status delivery is disabled by this fixture"))
        : client.request({ ...input, endpoint: nativeOrigin }) }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new TypeError("ordinary listener is unavailable");
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

export function hostAuthorization(hostId: "host-a" | "host-b"): string {
  return authorization(hostId, hostId === "host-a" ? bundleSecrets.host : hostBToken);
}
export function queryAuthorization(): string {
  return authorization("native-query", bundleSecrets.nativeQuery);
}
export function registrarAuthorization(): string {
  return authorization("ordinary-registrar", bundleSecrets.registrar);
}
export function claimRequest(requestId: string, hostId: "host-a" | "host-b", capacity: "primary" | "backup") {
  return { schemaVersion: 1, requestId, generationId, hostId, capacity } as const;
}
export function verificationRequest(claim: unknown) {
  return { schemaVersion: 1, requestId: randomUUID(), generationId, claim } as const;
}
export async function post(origin: string, path: string, authorizationHeader: string, body: object): Promise<HttpResult> {
  const response = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: { authorization: authorizationHeader, "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const responseBody = response.status === 204 ? undefined : await response.json();
  return { status: response.status, body: responseBody };
}
export function rows(file: string): Readonly<Record<string, unknown>> {
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    return {
      epochs: database.prepare("SELECT epoch_id, generation_id, active FROM native_root_ci_service_epochs ORDER BY started_at").all(),
      demands: database.prepare("SELECT demand_id, state FROM native_root_ci_demands ORDER BY created_at").all(),
      claims: database.prepare(`SELECT claim_id, issuance_request_id, demand_id, host_id, capacity,
        service_epoch_id, state FROM native_root_ci_claims ORDER BY created_at`).all()
    };
  } finally {
    database.close();
  }
}

function webhookAuthorization(): string {
  return authorization("native-events", bundleSecrets.webhook);
}
function authorization(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}
function activate(origin: string): Promise<HttpResult> {
  return post(origin, "/v1/activation", `Bearer ${activationToken}`, { schemaVersion: 1, generationId });
}
function eligibilityGeneration(body: unknown): string {
  const value = typeof body === "object" && body !== null ? Reflect.get(body, "eligibilityGeneration") : undefined;
  if (typeof value !== "string") throw new TypeError("admission generation is unavailable");
  return value;
}
async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
}

type RunningOrdinary = { readonly server: Server; readonly origin: string };
type HttpResult = { readonly status: number; readonly body: unknown };

function nativeServerOrigin(server: Server): string {
  const address = server.address();
  if (address === null || typeof address === "string") throw new TypeError("native listener is unavailable");
  return `http://127.0.0.1:${address.port}`;
}
