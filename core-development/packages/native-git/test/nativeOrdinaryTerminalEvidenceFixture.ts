import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect } from "vitest";
import { createNativeGitAttemptIssuerClient } from "../../../../core/packages/core/src/nativeGitAttemptIssuerClient.js";
import { createNodeNativeGitAdmissionHttpClient } from "../../../../core/packages/core/src/nativeGitAdmissionSource.js";
import { parseNativeOrdinaryBundleConfig } from "../../../../core/packages/core/src/nativeOrdinaryBundleConfig.js";
import { configuredNativeRootAdmissionServer } from "../../../../core/packages/core/src/nativeRootAdmissionService.js";
import {
  parseNativeRootCiClaim,
  type NativeRootCiClaim
} from "../../../../core/packages/core/src/nativeRootCiClaimProtocol.js";
import type { NativeJobAttemptIssuance } from "../../../../core/packages/core/src/nativeGitAttemptIssuerModel.js";
import type { AdmissionVerifierHttpClient } from "../../../../core/packages/native-git/src/ordinary-admission-http.js";
import { bundleSecrets, idleOrdinaryConfig } from "./bundleConfigFixture.js";
import { createBundleReview, nativeBundleReviewFixture } from "./nativeBundleReviewFixture.js";
import { generationId, type RunningService } from "./nativeRootImportFinalizeFixture.js";

const readinessToken = Buffer.alloc(32, 81).toString("base64url");
const activationToken = Buffer.alloc(32, 82).toString("base64url");
const ordinaryFixtures: NativeOrdinaryTerminalFixture[] = [];

export type NativeOrdinaryTerminalFixture = {
  readonly nativeRoot: string;
  readonly ordinaryRoot: string;
  readonly native: RunningService;
  readonly ordinary: Server;
  readonly ordinaryOrigin: string;
  readonly database: string;
  readonly reviewId: string;
  restartOrdinary(): Promise<NativeOrdinaryTerminalFixture>;
  close(): Promise<void>;
};

type FixtureValueInput = {
  readonly nativeRoot: string;
  readonly ordinaryRoot: string;
  readonly native: RunningService;
  readonly ordinary: Server;
  readonly reviewId: string;
  readonly deliverStatus: boolean;
  readonly updateOrigin: (origin: string) => void;
};

export async function nativeOrdinaryTerminalFixture(
  label: string,
  deliverStatus = true
): Promise<NativeOrdinaryTerminalFixture> {
  const transport = createNodeNativeGitAdmissionHttpClient();
  let ordinaryOrigin = "http://127.0.0.1:1";
  const nativeHttpClient: AdmissionVerifierHttpClient = {
    request: (input) => transport.request({ ...input, endpoint: ordinaryOrigin })
  };
  const nativeFixture = await nativeBundleReviewFixture(label, undefined, undefined, undefined, nativeHttpClient);
  const envelope = await createBundleReview(nativeFixture.service);
  const ordinaryRoot = await mkdtemp(join(tmpdir(), "dim-native-terminal-ordinary-"));
  await chmod(ordinaryRoot, 0o750);
  const ordinary = await startOrdinary(ordinaryRoot, nativeFixture.service.origin, deliverStatus);
  ordinaryOrigin = origin(ordinary);
  await activate(ordinaryOrigin);
  expect((await jsonPost(ordinaryOrigin, "/v1/projects/project-a/repositories/root/native-root-admission/register",
    authorization("ordinary-registrar", bundleSecrets.registrar), {
      schemaVersion: 1,
      requestId: randomUUID(),
      generationId
    })).status).toBe(200);
  await waitFor(() => eventReceiptCount(join(ordinaryRoot, "ordinary-ci.sqlite3")) === 1);
  const fixture = fixtureValue({
    nativeRoot: nativeFixture.root,
    ordinaryRoot,
    native: nativeFixture.service,
    ordinary,
    reviewId: envelope.review.reviewId,
    deliverStatus,
    updateOrigin: (value) => { ordinaryOrigin = value; }
  });
  ordinaryFixtures.push(fixture);
  return fixture;
}

export async function cleanupNativeOrdinaryTerminalFixtures(): Promise<void> {
  await Promise.all(ordinaryFixtures.splice(0).map((fixture) => fixture.close()));
}

export async function createActiveAttempt(fixture: NativeOrdinaryTerminalFixture): Promise<{
  readonly claim: NativeRootCiClaim;
  readonly issuance: NativeJobAttemptIssuance;
}> {
  const claimed = await jsonPost(fixture.ordinaryOrigin, "/v1/host-claims",
    authorization("host-a", bundleSecrets.host), {
      schemaVersion: 1,
      requestId: randomUUID(),
      generationId,
      hostId: "host-a",
      capacity: "primary"
    });
  expect(claimed.status).toBe(201);
  const claim = parseNativeRootCiClaim(claimed.body);
  const transport = createNodeNativeGitAdmissionHttpClient();
  const issuer = createNativeGitAttemptIssuerClient({
    config: {
      endpoint: "http://native-git:8080",
      serviceId: "native-main",
      attemptIssuer: { username: "ordinary-attempts", password: bundleSecrets.attemptIssuer }
    },
    generationId,
    httpClient: { request: (input) => transport.request({ ...input, endpoint: fixture.native.origin }) }
  });
  const descriptor = await issuer.loadDescriptor({ claim });
  const issuance = (await issuer.issueAttempt({ context: { claim }, descriptor })).issuance;
  expect((await jsonPost(fixture.ordinaryOrigin, "/v1/host-claim-activations",
    authorization("host-a", bundleSecrets.host), {
      schemaVersion: 1,
      requestId: randomUUID(),
      generationId,
      claim,
      issuance
    })).status).toBe(201);
  return { claim, issuance };
}

function fixtureValue(input: FixtureValueInput): NativeOrdinaryTerminalFixture {
  const ordinaryOrigin = origin(input.ordinary);
  return {
    nativeRoot: input.nativeRoot,
    ordinaryRoot: input.ordinaryRoot,
    native: input.native,
    ordinary: input.ordinary,
    ordinaryOrigin,
    database: join(input.ordinaryRoot, "ordinary-ci.sqlite3"),
    reviewId: input.reviewId,
    async restartOrdinary() {
      await closeServer(input.ordinary);
      const restarted = await startOrdinary(input.ordinaryRoot, input.native.origin, input.deliverStatus);
      const restartedOrigin = origin(restarted);
      input.updateOrigin(restartedOrigin);
      await activate(restartedOrigin);
      return fixtureValue({ ...input, ordinary: restarted });
    },
    async close() {
      await closeServer(input.ordinary);
      await rm(input.ordinaryRoot, { recursive: true, force: true });
    }
  };
}

async function startOrdinary(root: string, nativeOrigin: string, deliverStatus: boolean): Promise<Server> {
  const transport = createNodeNativeGitAdmissionHttpClient();
  const proofHttpClient = {
    request: (input: Parameters<typeof transport.request>[0]) => input.path.endsWith("/statuses") && !deliverStatus
      ? Promise.reject(new Error("status delivery is disabled"))
      : transport.request({ ...input, endpoint: nativeOrigin })
  };
  const server = await configuredNativeRootAdmissionServer({
    config: parseNativeOrdinaryBundleConfig(idleOrdinaryConfig()),
    stateDirectory: root,
    readinessToken,
    activationToken,
    expectedGenerationId: generationId,
    proofHttpClient
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}

async function activate(serviceOrigin: string): Promise<void> {
  expect((await fetch(`${serviceOrigin}/v1/activation`, {
    method: "POST",
    headers: { authorization: `Bearer ${activationToken}`, "content-type": "application/json" },
    body: JSON.stringify({ schemaVersion: 1, generationId })
  })).status).toBe(200);
}

async function jsonPost(serviceOrigin: string, path: string, auth: string, body: object) {
  const response = await fetch(`${serviceOrigin}${path}`, {
    method: "POST",
    headers: { authorization: auth, "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: response.status === 204 ? undefined : await response.json() };
}

function eventReceiptCount(databasePath: string): number {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try { return Number(database.prepare("SELECT COUNT(*) count FROM native_root_ci_event_receipts").get()?.count); }
  finally { database.close(); }
}

function origin(server: Server): string {
  const address = server.address();
  if (address === null || typeof address === "string") throw new TypeError("ordinary listener is unavailable");
  return `http://127.0.0.1:${address.port}`;
}

function authorization(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("condition was not observed");
}
