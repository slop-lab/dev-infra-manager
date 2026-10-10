import { once } from "node:events";
import { createServer } from "node:http";
import { createNativeBundleShutdown } from "./native-bundle-shutdown.js";
import { createAuthoritativeNativeAdmissionResolver } from "./authoritative-native-admission-resolver.js";
import { parseNativeGitBundleConfig } from "./bundle-config.js";
import {
  createNodeAdmissionVerifierHttpClient,
} from "./ordinary-admission-http.js";
import {
  assertBundleToken,
  assertGenerationId,
  sendJson,
} from "./native-bundle-http.js";
import { createNativeBundleRequestHandler } from "./native-bundle-request-handler.js";
import { initializeNativeBundleRuntime } from "./native-bundle-startup.js";
import { initializeNativeGitBundleState } from "./native-bundle-state.js";
import { assertDistinctNativeBundleServerCredentials } from "./native-bundle-credential-boundary.js";
import { createNativeProjectRootImportService } from "./native-project-root-import-http.js";
import { createNativeProjectRootReadService } from "./native-project-root-read-http.js";
import { createRootReadOperationGate } from "./native-root-read-lifecycle.js";
import { createNativeProjectWorkspaceWriteService } from "./native-project-workspace-write-http.js";
import { createAuthoritativeNativeReviewController } from "./authoritative-native-review-controller.js";
import { parseNativeGitProjectRegistrars } from "./native-project-registrar-http.js";
import { executeNativeProjectPreparation } from "./native-project-registration.js";
import {
  NativeGitBundleServerError,
  type NativeGitBundleServer,
  type NativeGitBundleServerOptions,
  type NativeGitPreparedProject
} from "./native-bundle-server-types.js";
import { createNativeHumanReviewerService } from "./native-human-reviewer-http.js";
import { deriveAuthoritativeOrdinaryExecutionDescriptor } from "./authoritative-ordinary-execution-descriptor.js";
import { deriveAuthoritativeQemuExecutionDescriptor } from "./authoritative-qemu-execution-descriptor.js";
import { createNativeRootCiProofService } from "./native-root-ci-proof-http.js";
import { createAuthoritativeNativeEventDispatcher,
  type AuthoritativeNativeEventDispatcher } from "./authoritative-native-event-dispatcher.js";
import { nativeBundleKnownCredentials } from "./native-bundle-known-credentials.js";

export { NativeGitBundleServerError } from "./native-bundle-server-types.js";
export type {
  AuthoritativeNativeReviewSelector,
  NativeGitBundleServer,
  NativeGitBundleServerOptions,
  NativeGitPreparedProject
} from "./native-bundle-server-types.js";

export async function configuredNativeGitBundleServer(
  options: NativeGitBundleServerOptions
): Promise<NativeGitBundleServer> {
  const config = parseNativeGitBundleConfig(options.config);
  assertBundleToken(options.readinessToken, "readiness");
  assertBundleToken(options.activationToken, "activation");
  assertGenerationId(options.expectedGenerationId);
  const registrars = parseNativeGitProjectRegistrars(config.projectRegistrars);
  assertDistinctNativeBundleServerCredentials(config, registrars, options);
  const state = await initializeNativeGitBundleState(options.stateDirectory, options.expectedGenerationId);
  const identityHttpClient = options.ordinaryIdentityHttpClient ?? createNodeAdmissionVerifierHttpClient();
  let preparationQueue = Promise.resolve();
  let closed = false;
  let startup;
  try {
    startup = await initializeNativeBundleRuntime(config, options, state);
  } catch (error) {
    await state.owner.release();
    throw error;
  }
  const { activationTokenDigest, gitIdentity, runtimeConfig } = startup;
  let { activated } = startup;
  const rootImportService = createNativeProjectRootImportService({
    activated: () => activated,
    activationTokenDigest,
    available: () => !closed,
    expectedGenerationId: options.expectedGenerationId,
    stateDirectory: options.stateDirectory,
    state,
    importers: config.projectRootImporters,
    humanReviewers: config.humanReviewers,
    knownCredentials: nativeBundleKnownCredentials(config, registrars, "root-importers"),
    gitExecutable: config.gitExecutable,
    gitIdentity
  });
  const transportOperations = createRootReadOperationGate(16);
  const authoritativeRuntime = {
    activated: () => activated,
    activationTokenDigest,
    expectedGenerationId: options.expectedGenerationId,
    gitExecutable: config.gitExecutable,
    gitIdentity,
    state
  };
  let eventDispatcher: AuthoritativeNativeEventDispatcher;
  try {
    eventDispatcher = await createAuthoritativeNativeEventDispatcher({
      webhook: config.ordinaryCi.webhook,
      resolveAdmission: createAuthoritativeNativeAdmissionResolver({
        dependency: config.ordinaryCi,
        generationId: options.expectedGenerationId,
        httpClient: identityHttpClient
      }),
      state,
      stateDirectory: options.stateDirectory,
    generationId: options.expectedGenerationId,
    httpClient: identityHttpClient,
    ...(options.deliveryFaults === undefined ? {} : { deliveryFaults: options.deliveryFaults })
    });
  } catch (error) {
    await state.owner.release();
    throw error;
  }
  const reviewController = createAuthoritativeNativeReviewController({
    available: () => !closed,
    operations: transportOperations,
    runtime: authoritativeRuntime,
    ...(options.authoritativeReviewHooks === undefined ? {} : { hooks: options.authoritativeReviewHooks })
  });
  const rootReadService = createNativeProjectRootReadService({
    activated: () => activated,
    activationTokenDigest,
    expectedGenerationId: options.expectedGenerationId,
    gitExecutable: config.gitExecutable,
    gitIdentity,
    issuers: config.projectRootReadIssuers,
    knownCredentials: nativeBundleKnownCredentials(config, registrars, "root-read-issuers"),
    now: options.rootReadLeaseClock ?? Date.now,
    operations: transportOperations,
    ...(options.rootReadLeaseHooks === undefined ? {} : { hooks: options.rootReadLeaseHooks }),
    state,
    stateDirectory: options.stateDirectory
  });
  const workspaceWriteService = createNativeProjectWorkspaceWriteService({
    activated: () => activated,
    activationTokenDigest,
    expectedGenerationId: options.expectedGenerationId,
    gitExecutable: config.gitExecutable,
    gitIdentity,
    issuers: config.workspaceWriteIssuers,
    knownCredentials: nativeBundleKnownCredentials(config, registrars, "workspace-write-issuers"),
    now: options.workspaceWriteLeaseClock ?? Date.now,
    operations: transportOperations,
    ...(options.workspaceWriteLeaseHooks === undefined ? {} : { hooks: options.workspaceWriteLeaseHooks }),
    state,
    stateDirectory: options.stateDirectory
  });
  const knownCredentials = nativeBundleKnownCredentials(config, registrars);
  const humanReviewerService = createNativeHumanReviewerService({
    config,
    knownCredentials,
    serialize: reviewController.run,
    ...(options.nativeHumanReviewerHooks === undefined ? {} : { hooks: options.nativeHumanReviewerHooks }),
    runtime: authoritativeRuntime
  });
  const rootCiProofService = createNativeRootCiProofService({
    credential: config.ordinaryCi.identity,
    knownCredentials,
    runtime: authoritativeRuntime,
    serialize: reviewController.run
  });
  const prepareProject = (generationId: string, ownerHostId: string, input: unknown): Promise<NativeGitPreparedProject> => {
    if (closed) return Promise.reject(new NativeGitBundleServerError("native Git bundle server is closed"));
    const operation = preparationQueue.then(async () => {
      if (!activated || generationId !== options.expectedGenerationId) {
        throw new NativeGitBundleServerError("native Project preparation requires exact activation");
      }
      return executeNativeProjectPreparation({
        database: state.database,
        stateDirectory: options.stateDirectory,
        runtimeConfig,
        generationId,
        ownerHostId,
        input
      });
    });
    preparationQueue = operation.then(() => undefined, () => undefined);
    return operation;
  };
  const handle = createNativeBundleRequestHandler({
    activationTokenDigest,
    config,
    identityHttpClient,
    options,
    registrars,
    rootImportService,
    rootReadService,
    state,
    workspaceWriteService,
    humanReviewerService,
    rootCiProofService,
    deliveryHealthy: eventDispatcher.healthy,
    activated: () => activated,
    activate: () => { activated = true; },
    prepareProject
  });
  const server = createServer((request, response) => {
    if (closed) {
      sendJson(response, 503, { error: "native Git bundle server is closed" });
      return;
    }
    void handle(request, response).catch(() => {
      if (closed || response.headersSent || response.writableEnded) response.destroy();
      else sendJson(response, 500, { error: "internal server error" });
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 1_000;
  server.maxRequestsPerSocket = 100;
  server.on("listening", () => {
    if (closed) {
      server.closeAllConnections();
      server.close();
      return;
    }
    eventDispatcher.start();
  });
  const close = createNativeBundleShutdown({ server, eventDispatcher, state,
    stopAdmission() {
      closed = true;
      rootReadService.close();
      workspaceWriteService.close();
    },
    async drainOperations() {
      const transportClosed = transportOperations.close();
      await Promise.all([preparationQueue, reviewController.waitForIdle()]);
      await Promise.all([rootImportService.waitForIdle(), transportClosed]);
    }
  });

  return {
    server,
    async listen(host = config.host, port = config.port) {
      if (closed) throw new NativeGitBundleServerError("native Git bundle server is closed");
      server.listen(port, host);
      await once(server, "listening");
      const address = server.address();
      if (address === null || typeof address === "string") throw new NativeGitBundleServerError("expected a TCP listener");
      return `http://${host}:${address.port}`;
    },
    prepareProject,
    async createReview(input) {
      const review = await reviewController.create(input);
      eventDispatcher.wake();
      return review;
    },
    deriveOrdinaryExecutionDescriptor(input) {
      return reviewController.run(() => deriveAuthoritativeOrdinaryExecutionDescriptor(authoritativeRuntime, input));
    },
    deriveQemuExecutionDescriptor(input) {
      return reviewController.run(() => deriveAuthoritativeQemuExecutionDescriptor(authoritativeRuntime, input));
    },
    close
  };

}
