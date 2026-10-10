import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createNodeNativeGitAdmissionHttpClient } from "../../../../core/packages/core/src/nativeGitAdmissionHttpClient.js";
import { parseNativeOrdinaryBundleConfig } from "../../../../core/packages/core/src/nativeOrdinaryBundleConfig.js";
import { configuredNativeRootAdmissionServer } from "../../../../core/packages/core/src/nativeRootAdmissionService.js";
import type {
  AdmissionVerifierHttpClient,
  AdmissionVerifierHttpRequest,
  AdmissionVerifierHttpResponse
} from "../../../../core/packages/native-git/src/ordinary-admission-http.js";
import { bundleSecrets, idleOrdinaryConfig } from "./bundleConfigFixture.js";
import { nativeBundleReviewFixture, type NativeBundleReviewFixture } from "./nativeBundleReviewFixture.js";
import { generationId } from "./nativeRootImportFinalizeFixture.js";

const readinessToken = Buffer.alloc(32, 71).toString("base64url");
const activationToken = Buffer.alloc(32, 72).toString("base64url");

export type DeliveryBridgeMode = "normal" | "stale" | "unavailable";
export class DeliveryBridge implements AdmissionVerifierHttpClient {
  mode: DeliveryBridgeMode = "normal";
  targetOrigin: string | undefined;
  loseNextReceiptAcknowledgement = false;
  failNextMarkerWrite = false;
  failMarkerIntegrity = false;
  markerFailures = 0;
  readonly requests: AdmissionVerifierHttpRequest[] = [];
  readonly receiptBodies: string[] = [];
  private lostAcknowledgementResolve: (() => void) | undefined;
  readonly lostAcknowledgement = new Promise<void>((resolve) => { this.lostAcknowledgementResolve = resolve; });

  async request(input: AdmissionVerifierHttpRequest): Promise<AdmissionVerifierHttpResponse> {
    this.requests.push(input);
    if (input.path.endsWith("/discover") && this.mode !== "normal") {
      return jsonResponse(this.mode === "stale" ? 409 : 503, { error: this.mode });
    }
    const origin = this.targetOrigin;
    if (origin === undefined) return jsonResponse(503, { error: "unavailable" });
    const response = await fetch(`${origin}${input.path}`, { method: input.method, signal: input.signal,
      headers: { authorization: input.authorization, accept: "application/json",
        ...(input.body === undefined ? {} : { "content-type": "application/json" }) },
      ...(input.body === undefined ? {} : { body: input.body }) });
    const result = { statusCode: response.status, contentType: response.headers.get("content-type") ?? undefined,
      cacheControl: response.headers.get("cache-control") ?? undefined,
      body: Buffer.from(await response.arrayBuffer()) };
    if (input.path === "/v1/native-root-ci-events") {
      this.receiptBodies.push(input.body ?? "");
      if (this.loseNextReceiptAcknowledgement) {
        this.loseNextReceiptAcknowledgement = false;
        this.lostAcknowledgementResolve?.();
        throw new LostAcknowledgementError();
      }
    }
    return result;
  }
}

export type DeliveryScenario = {
  readonly bridge: DeliveryBridge;
  readonly native: NativeBundleReviewFixture;
  readonly ordinaryServer: Server;
  readonly ordinaryOrigin: string;
  readonly ordinaryDatabase: string;
  readonly admissionGeneration: string;
  close(): Promise<void>;
};

export async function startDeliveryScenario(label: string): Promise<DeliveryScenario> {
  const bridge = new DeliveryBridge();
  const native = await nativeBundleReviewFixture(label, undefined, undefined, undefined, bridge, {
    beforePublish() {
      if (bridge.failMarkerIntegrity) {
        bridge.markerFailures += 1;
        throw new DeliveryFixtureError("simulated delivery marker integrity failure");
      }
      if (!bridge.failNextMarkerWrite) return;
      bridge.failNextMarkerWrite = false;
      bridge.markerFailures += 1;
      throw Object.assign(new Error("simulated marker write unavailable"), { code: "ENOSPC" });
    }
  });
  const root = await mkdtemp(join(tmpdir(), `dim-authoritative-delivery-${label}-`));
  const nodeClient = createNodeNativeGitAdmissionHttpClient();
  const ordinaryServer = await configuredNativeRootAdmissionServer({
    config: parseNativeOrdinaryBundleConfig(idleOrdinaryConfig()), stateDirectory: join(root, "ordinary"),
    readinessToken, activationToken, expectedGenerationId: generationId,
    proofHttpClient: { request: (input) => nodeClient.request({ ...input, endpoint: native.service.origin }) }
  });
  await new Promise<void>((resolve) => ordinaryServer.listen(0, "127.0.0.1", resolve));
  const address = ordinaryServer.address();
  if (address === null || typeof address === "string") throw new DeliveryFixtureError("ordinary listener is unavailable");
  const ordinaryOrigin = `http://127.0.0.1:${address.port}`;
  bridge.targetOrigin = ordinaryOrigin;
  await post(ordinaryOrigin, "/v1/activation", `Bearer ${activationToken}`, { schemaVersion: 1, generationId });
  const registered = await post(ordinaryOrigin,
    "/v1/projects/project-a/repositories/root/native-root-admission/register",
    authorization("ordinary-registrar", bundleSecrets.registrar),
    { schemaVersion: 1, requestId: randomUUID(), generationId });
  const body: unknown = await registered.json();
  if (!registered.ok || typeof body !== "object" || body === null) throw new DeliveryFixtureError("admission failed");
  const admission = Reflect.get(body, "admission");
  const admissionGeneration = typeof admission === "object" && admission !== null
    ? Reflect.get(admission, "admissionGeneration") : undefined;
  if (typeof admissionGeneration !== "string") throw new DeliveryFixtureError("admission generation is missing");
  return { bridge, native, ordinaryServer, ordinaryOrigin,
    ordinaryDatabase: join(root, "ordinary", "ordinary-ci.sqlite3"), admissionGeneration,
    async close() {
      if (ordinaryServer.listening) {
        ordinaryServer.closeAllConnections();
        await new Promise<void>((resolve, reject) => ordinaryServer.close((error) => error === undefined
          ? resolve() : reject(error)));
      }
      await rm(root, { recursive: true, force: true });
    } };
}

export function receiptRows(file: string): readonly Readonly<Record<string, unknown>>[] {
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    return database.prepare(`SELECT admission_generation, event_id, event_digest
      FROM native_root_ci_event_receipts ORDER BY event_id`).all();
  } finally { database.close(); }
}

export function authorization(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}
export function post(origin: string, path: string, authorizationHeader: string, body: object): Promise<Response> {
  return fetch(`${origin}${path}`, { method: "POST", headers: { authorization: authorizationHeader,
    "content-type": "application/json" }, body: JSON.stringify(body) });
}
export async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new DeliveryFixtureError("delivery condition was not reached");
}
function jsonResponse(statusCode: number, body: object): AdmissionVerifierHttpResponse {
  return { statusCode, contentType: "application/json", cacheControl: "no-store",
    body: Buffer.from(JSON.stringify(body)) };
}
class LostAcknowledgementError extends Error { readonly name = "LostAcknowledgementError"; }
class DeliveryFixtureError extends Error { readonly name = "DeliveryFixtureError"; }
