import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { DatabaseSync } from "node:sqlite";
import type { NativeOrdinaryAuthorityConfig } from "./nativeOrdinaryAuthorityConfig.js";
import { validateNativeOrdinaryAuthorityConfig } from "./nativeOrdinaryAuthorityConfig.js";
import { nativeCapacityConfigDigest } from "./nativeOrdinaryAuthorityProtocol.js";
import {
  parseNativeRootAdmissionRequest,
  nativeRootAdmissionTupleDigest,
  NativeRootAdmissionRequestError,
  type NativeRootAdmissionOperation
} from "./nativeRootAdmissionModel.js";
import { NativeRootAdmissionStore } from "./nativeRootAdmissionStore.js";
import {
  createNativeRootCiProofClient,
  type NativeRootCiProofHttpClient
} from "./nativeRootCiProofClient.js";
import { initializeNativeOrdinaryBundleState, secureNativeOrdinaryDatabaseFiles } from "./nativeOrdinaryBundleState.js";
import { createNativeRootCiEventReceiptHandler } from "./nativeRootCiEventReceiptHttp.js";
import { NativeRootCiEventReceiptStore } from "./nativeRootCiEventReceiptStore.js";
import { createNativeRootCiClaimHandler } from "./nativeRootCiClaimHttp.js";
import { NativeRootCiClaimStore } from "./nativeRootCiClaimStore.js";
import { createNativeRootCiClaimLifecycleHandler } from "./nativeRootCiClaimLifecycleHttp.js";
import { NativeRootCiClaimLifecycleStore } from "./nativeRootCiClaimLifecycleStore.js";
import { createNativeRootCiResultHandler } from "./nativeRootCiResultHttp.js";
import { NativeRootCiResultStore } from "./nativeRootCiResultStore.js";
import { createNativeRootCiResultProofHandler } from "./nativeRootCiResultProofHttp.js";
import { NativeRootCiResultProofStore } from "./nativeRootCiResultProofStore.js";
import { createNativeRootCiTerminalResultProofHandler } from "./nativeRootCiTerminalResultProofHttp.js";
import { NativeRootCiTerminalResultProofStore } from "./nativeRootCiTerminalResultProofStore.js";
import { assertNativeRootCiResultIntegrity } from "./nativeRootCiResultIntegrity.js";
import { NativeRootCiResultReporter } from "./nativeRootCiResultReporter.js";
import { createNodeNativeGitAdmissionHttpClient } from "./nativeGitAdmissionSource.js";
import { createNativeGitAttemptIssuerClient } from "./nativeGitAttemptIssuerClient.js";
import { createNativeGitCurrentAttemptProofClient } from "./nativeGitCurrentAttemptProofClient.js";
import { createNativeRootAdmissionReadHandler } from "./nativeRootAdmissionReadHttp.js";
import { createNativeRootAdmissionResponse } from "./nativeRootAdmissionResponse.js";
import {
  nativeRootBasicAuthorized,
  nativeRootBearerAuthorized,
  readNativeRootAdmissionJson,
  sendNativeRootAdmissionError,
  sendNativeRootJson,
  sendNativeRootNotFound
} from "./nativeRootAdmissionHttp.js";
import {
  activationGeneration,
  activationIsBound,
  activationTokenDigest,
  assertActivationOptions,
  bindActivation
} from "./nativeRootAdmissionActivation.js";

const projectPattern = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export type NativeRootAdmissionServiceOptions = {
  readonly config: NativeOrdinaryAuthorityConfig;
  readonly stateDirectory: string;
  readonly readinessToken: string;
  readonly activationToken: string;
  readonly expectedGenerationId: string;
  readonly proofHttpClient?: NativeRootCiProofHttpClient;
  readonly now?: () => number;
};

export async function configuredNativeRootAdmissionServer(
  options: NativeRootAdmissionServiceOptions
): Promise<Server> {
  const capacities = validateNativeOrdinaryAuthorityConfig(options.config);
  assertActivationOptions(options, options.expectedGenerationId);
  const state = await initializeNativeOrdinaryBundleState(options.stateDirectory);
  const database = new DatabaseSync(state.database);
  try { database.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL;");
    await secureNativeOrdinaryDatabaseFiles(options.stateDirectory); }
  catch (error) { database.close(); throw error; }
  const capacityConfigDigest = nativeCapacityConfigDigest([...capacities.values()]);
  assertNativeRootCiResultIntegrity(database, 100_000, options.config.nativeGit.resultReporter.username);
  const store = new NativeRootAdmissionStore(database, { ordinaryServiceId: options.config.serviceId,
    controlPlaneGenerationId: options.expectedGenerationId, capacityConfigDigest,
    leaseMilliseconds: options.config.admissionLeaseMilliseconds, now: options.now ?? Date.now });
  const nativeGitHttpClient = options.proofHttpClient ?? createNodeNativeGitAdmissionHttpClient();
  const proofClient = createNativeRootCiProofClient({ endpoint: options.config.nativeGit.endpoint,
    serviceId: options.config.nativeGit.serviceId, generationId: options.expectedGenerationId,
    identity: options.config.nativeGit.identity }, nativeGitHttpClient);
  const activationDigest = activationTokenDigest(options.activationToken);
  const serviceEpochId = randomUUID();
  let activated = false;
  const activationBound = () => activationIsBound(database, options.expectedGenerationId, activationDigest);
  const receiptStore = new NativeRootCiEventReceiptStore(database, { ordinaryServiceId: options.config.serviceId,
    controlPlaneGenerationId: options.expectedGenerationId, capacityConfigDigest,
    activated: () => activated, activationBound, now: options.now ?? Date.now });
  const handleReceipt = createNativeRootCiEventReceiptHandler({ config: options.config,
    expectedGenerationId: options.expectedGenerationId, store: receiptStore, proofClient,
    activated: () => activated, activationBound });
  const handleRead = createNativeRootAdmissionReadHandler({ config: options.config,
    generationId: options.expectedGenerationId, store,
    active: () => activated && activationBound() });
  const claimStore = new NativeRootCiClaimStore(database, { serviceId: options.config.serviceId,
    generationId: options.expectedGenerationId, serviceEpochId, capacityConfigDigest,
    capacities, now: options.now ?? Date.now });
  const handleClaim = createNativeRootCiClaimHandler({ config: options.config,
    generationId: options.expectedGenerationId, serviceEpochId, capacities, store: claimStore,
    active: () => activated && activationBound() });
  const lifecycleStore = new NativeRootCiClaimLifecycleStore(database, { serviceId: options.config.serviceId,
    generationId: options.expectedGenerationId, serviceEpochId,
    leaseMilliseconds: options.config.claimLeaseMilliseconds, now: options.now ?? Date.now });
  const attemptProof = createNativeGitCurrentAttemptProofClient({ endpoint: options.config.nativeGit.endpoint,
    serviceId: options.config.nativeGit.serviceId, generationId: options.expectedGenerationId,
    identity: options.config.nativeGit.identity,
    httpClient: nativeGitHttpClient });
  const attemptIssuer = createNativeGitAttemptIssuerClient({ config: options.config.nativeGit,
    generationId: options.expectedGenerationId,
    httpClient: nativeGitHttpClient });
  const handleClaimLifecycle = createNativeRootCiClaimLifecycleHandler({ config: options.config,
    generationId: options.expectedGenerationId, capacities, store: lifecycleStore,
    proof: attemptProof, issuer: attemptIssuer, httpClient: nativeGitHttpClient,
    claimCurrent: (claim) => claimStore.verify(claim) === "current",
    active: () => activated && activationBound() });
  const resultStore = new NativeRootCiResultStore(database, { generationId: options.expectedGenerationId,
    serviceEpochId, capacityConfigDigest, now: options.now ?? Date.now });
  const handleResult = createNativeRootCiResultHandler({ config: options.config,
    generationId: options.expectedGenerationId, capacities, store: resultStore,
    active: () => activated && activationBound() });
  const handleResultProof = createNativeRootCiResultProofHandler({ config: options.config,
    generationId: options.expectedGenerationId, store: new NativeRootCiResultProofStore(database, {
      generationId: options.expectedGenerationId, serviceEpochId, capacityConfigDigest, now: options.now ?? Date.now
    }), active: () => activated && activationBound() });
  const handleTerminalResultProof = createNativeRootCiTerminalResultProofHandler({ config: options.config,
    generationId: options.expectedGenerationId, store: new NativeRootCiTerminalResultProofStore(database, {
      generationId: options.expectedGenerationId, capacityConfigDigest,
      reporterUsername: options.config.nativeGit.resultReporter.username, now: options.now ?? Date.now
    }), active: () => activated && activationBound() });
  const resultReporter = new NativeRootCiResultReporter({
    database,
    config: options.config,
    httpClient: nativeGitHttpClient,
    active: () => activated && activationBound(),
    generationId: options.expectedGenerationId,
    now: options.now ?? Date.now
  });
  const server = createServer((request, response) => {
    void handle(request, response).catch((error) => sendNativeRootAdmissionError(response, error));
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 1_000;
  server.maxRequestsPerSocket = 100;
  server.once("close", () => { void resultReporter.close().then(() => database.close()); });
  return server;

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://dim-native-root-admission");
    if (url.search !== "") return sendNativeRootNotFound(response);
    if (request.method === "GET" && url.pathname === "/readyz") {
      if (!nativeRootBearerAuthorized(request, options.readinessToken)) return sendNativeRootNotFound(response);
      if (!resultReporter.healthy) return sendNativeRootJson(response, 503, { error: "native result reporting integrity failed" });
      database.prepare("SELECT 1").get();
      return sendNativeRootJson(response, 200, { status: "ready", schemaVersion: 1 });
    }
    if (await handleRead(request, response, url)) return;
    if (await handleClaim(request, response, url)) return;
    if (await handleClaimLifecycle(request, response, url)) return;
    if (await handleResult(request, response, url) || await handleResultProof(request, response, url)
      || await handleTerminalResultProof(request, response, url)) return;
    if (request.method === "POST" && url.pathname === "/v1/activation") {
      if (request.socket.remoteAddress !== "127.0.0.1"
        || !nativeRootBearerAuthorized(request, options.activationToken)) return sendNativeRootNotFound(response);
      const generationId = activationGeneration(await readNativeRootAdmissionJson(request));
      if (generationId !== options.expectedGenerationId) return sendNativeRootJson(response, 409,
        { error: "activation generation conflicts with service startup" });
      if (!bindActivation(database, generationId, activationDigest)) return sendNativeRootJson(response, 409,
        { error: "ordinary CI activation binding conflicts with durable state" });
      store.activate();
      claimStore.activateEpoch();
      activated = true;
      return sendNativeRootJson(response, 200, { schemaVersion: 1, generationId, activated: true });
    }
    if (await handleReceipt(request, response, url)) return;
    const route = admissionRoute(url.pathname);
    if (request.method !== "POST" || route === undefined) return sendNativeRootNotFound(response);
    const credential = route.operation === "current" ? options.config.credentials.query : options.config.credentials.registrar;
    if (!nativeRootBasicAuthorized(request, credential)) return sendNativeRootNotFound(response);
    if (!activated || !activationIsBound(database, options.expectedGenerationId, activationDigest)) {
      return sendNativeRootJson(response, 503, { error: "native root admission requires exact generation activation" });
    }
    const input = parseNativeRootAdmissionRequest(await readNativeRootAdmissionJson(request), route.operation);
    if (input.generationId !== options.expectedGenerationId) {
      return sendNativeRootJson(response, 409, { error: "native root admission generation is stale" });
    }
    const tupleDigest = nativeRootAdmissionTupleDigest(route.operation, route.projectId, input);
    const replay = store.replay(input.requestId, route.operation, tupleDigest);
    switch (replay.kind) {
      case "conflict": return sendNativeRootJson(response, 409, { error: "request replay conflicts" });
      case "replay": return sendNativeRootJson(response, replay.response.status, replay.response.body);
      case "none": break;
      default: return assertNever(replay);
    }
    if (!store.hasRequestCapacity()) {
      return sendNativeRootJson(response, 429, { error: "native root admission request capacity is full" });
    }
    if (route.operation === "register") {
      const proof = await proofClient.readImportedPolicy(route.projectId, AbortSignal.timeout(5_000));
      return sendAdmissionResult(response, store.commitRegistration({ proof, request: {
        requestId: input.requestId, operation: route.operation, tupleDigest,
        responseBody: (admission) => responseBody(input.requestId, admission)
      } }));
    }
    const admissionGeneration = input.admissionGeneration;
    if (admissionGeneration === undefined) throw new NativeRootAdmissionRequestError("admission generation is required");
    return sendAdmissionResult(response, store.commitExisting({ projectId: route.projectId, admissionGeneration,
      request: { requestId: input.requestId, operation: route.operation, tupleDigest,
        responseBody: (admission) => responseBody(input.requestId, admission) } }));
  }

  function responseBody(requestId: string, admission: import("./nativeRootAdmissionModel.js").NativeRootAdmission): unknown {
    return createNativeRootAdmissionResponse({ serviceId: options.config.serviceId,
      generationId: options.expectedGenerationId, requestId, admission });
  }

  function sendAdmissionResult(response: ServerResponse,
    result: ReturnType<NativeRootAdmissionStore["commitRegistration"]>): void {
    switch (result.kind) {
      case "committed":
      case "replay": return sendNativeRootJson(response, result.response.status, result.response.body);
      case "request-conflict": return sendNativeRootJson(response, 409, { error: "request replay conflicts" });
      case "capacity-full": return sendNativeRootJson(response, 429, { error: "native root admission request capacity is full" });
      case "operation-conflict": return sendNativeRootJson(response, 409, { error: "current imported root conflicts" });
      case "not-found": return sendNativeRootNotFound(response);
      default: return assertNever(result);
    }
  }
}

function admissionRoute(path: string): { readonly projectId: string; readonly operation: NativeRootAdmissionOperation } | undefined {
  const match = /^\/v1\/projects\/([^/]+)\/repositories\/root\/native-root-admission\/(register|current|revoke)$/.exec(path);
  if (match === null || !projectPattern.test(match[1] ?? "")) return undefined;
  const operation = match[2];
  if (operation !== "register" && operation !== "current" && operation !== "revoke") return undefined;
  return { projectId: match[1] ?? "", operation };
}

function assertNever(value: never): never { throw new TypeError(`unexpected native root admission result: ${JSON.stringify(value)}`); }
