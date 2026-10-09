import { once } from "node:events";
import { createServer } from "node:http";
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
    knownCredentials: [
      ...registrars,
      ...config.projectRootReadIssuers,
      ...config.workspaceWriteIssuers,
      ...config.humanReviewers,
      config.ordinaryCi.query,
      config.ordinaryCi.identity,
      config.ordinaryCi.attemptIssuer,
      config.ordinaryCi.resultReporter,
      config.ordinaryCi.webhook
    ],
    gitExecutable: config.gitExecutable,
    gitIdentity
  });
  const transportOperations = createRootReadOperationGate(16);
  const reviewController = createAuthoritativeNativeReviewController({
    available: () => !closed,
    operations: transportOperations,
    runtime: {
      activated: () => activated,
      activationTokenDigest,
      expectedGenerationId: options.expectedGenerationId,
      gitExecutable: config.gitExecutable,
      gitIdentity,
      state
    },
    ...(options.authoritativeReviewHooks === undefined ? {} : { hooks: options.authoritativeReviewHooks })
  });
  const rootReadService = createNativeProjectRootReadService({
    activated: () => activated,
    activationTokenDigest,
    expectedGenerationId: options.expectedGenerationId,
    gitExecutable: config.gitExecutable,
    gitIdentity,
    issuers: config.projectRootReadIssuers,
    knownCredentials: [
      ...registrars,
      ...config.projectRootImporters,
      ...config.workspaceWriteIssuers,
      ...config.humanReviewers,
      config.ordinaryCi.query,
      config.ordinaryCi.identity,
      config.ordinaryCi.attemptIssuer,
      config.ordinaryCi.resultReporter,
      config.ordinaryCi.webhook
    ],
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
    knownCredentials: [
      ...registrars,
      ...config.projectRootImporters,
      ...config.projectRootReadIssuers,
      ...config.humanReviewers,
      config.ordinaryCi.query,
      config.ordinaryCi.identity,
      config.ordinaryCi.attemptIssuer,
      config.ordinaryCi.resultReporter,
      config.ordinaryCi.webhook
    ],
    now: options.workspaceWriteLeaseClock ?? Date.now,
    operations: transportOperations,
    ...(options.workspaceWriteLeaseHooks === undefined ? {} : { hooks: options.workspaceWriteLeaseHooks }),
    state,
    stateDirectory: options.stateDirectory
  });
  const knownCredentials = [
    ...registrars,
    ...config.projectRootImporters,
    ...config.projectRootReadIssuers,
    ...config.workspaceWriteIssuers,
    config.ordinaryCi.query,
    config.ordinaryCi.identity,
    config.ordinaryCi.attemptIssuer,
    config.ordinaryCi.resultReporter,
    config.ordinaryCi.webhook
  ];
  const humanReviewerService = createNativeHumanReviewerService({
    config,
    knownCredentials,
    runtime: {
      activated: () => activated,
      activationTokenDigest,
      expectedGenerationId: options.expectedGenerationId,
      gitExecutable: config.gitExecutable,
      gitIdentity,
      state
    }
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
    activated: () => activated,
    activate: () => { activated = true; },
    prepareProject
  });
  const server = createServer((request, response) => {
    void handle(request, response).catch(() => {
      if (closed || response.headersSent || response.writableEnded) response.destroy();
      else sendJson(response, 500, { error: "internal server error" });
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 1_000;
  server.maxRequestsPerSocket = 100;

  return {
    server,
    async listen(host = config.host, port = config.port) {
      server.listen(port, host);
      await once(server, "listening");
      const address = server.address();
      if (address === null || typeof address === "string") throw new NativeGitBundleServerError("expected a TCP listener");
      return `http://${host}:${address.port}`;
    },
    prepareProject,
    createReview: reviewController.create,
    async close() {
      if (closed) return;
      closed = true;
      rootReadService.close();
      workspaceWriteService.close();
      const transportClosed = transportOperations.close();
      await Promise.all([preparationQueue, reviewController.waitForIdle()]);
      await Promise.all([rootImportService.waitForIdle(), transportClosed]);
      if (server.listening) {
        server.close();
        server.closeAllConnections();
        await once(server, "close");
      }
      await state.owner.release();
    }
  };

}
