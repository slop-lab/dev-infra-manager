import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { DatabaseSync } from "node:sqlite";
import type { NativeOrdinaryAuthorityConfig } from "./nativeOrdinaryAuthorityConfig.js";
import { validateNativeOrdinaryAuthorityConfig } from "./nativeOrdinaryAuthorityConfig.js";
import { nativeCapacityConfigDigest } from "./nativeOrdinaryAuthorityProtocol.js";
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
import {
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
    leaseMilliseconds: options.config.eligibilityLeaseMilliseconds, now: options.now ?? Date.now });
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
    activated: () => activated, activationBound,
    currentEligibility(projectId) { return store.discover(projectId)?.admissionGeneration; },
    async reconcileEligibility(projectId) {
      const proof = await proofClient.readImportedPolicy(projectId, AbortSignal.timeout(5_000));
      const result = store.register(proof);
      if (result.kind === "conflict") throw new NativeRootEligibilityConflictError();
      return result.admission.admissionGeneration;
    } });
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
    return sendNativeRootNotFound(response);
  }
}

class NativeRootEligibilityConflictError extends Error {
  readonly name = "NativeRootEligibilityConflictError";
}
