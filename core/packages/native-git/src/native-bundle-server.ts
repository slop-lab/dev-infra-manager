import { once } from "node:events";
import { createNativeBundleShutdown } from "./native-bundle-shutdown.js";
import { parseNativeGitBundleConfig } from "./bundle-config.js";
import { createNodeAdmissionVerifierHttpClient } from "./ordinary-admission-http.js";
import { assertBundleToken, assertGenerationId } from "./native-bundle-http.js";
import { createNativeBundleRequestHandler } from "./native-bundle-request-handler.js";
import { initializeNativeBundleRuntime } from "./native-bundle-startup.js";
import { initializeNativeGitBundleState } from "./native-bundle-state.js";
import { assertDistinctNativeBundleServerCredentials } from "./native-bundle-credential-boundary.js";
import { createNativeProjectRootImportService } from "./native-project-root-import-http.js";
import { createNativeProjectRootReadService } from "./native-project-root-read-http.js";
import { createRootReadOperationGate } from "./native-root-read-lifecycle.js";
import { createNativeProjectWorkspaceWriteService } from "./native-project-workspace-write-http.js";
import { createAuthoritativeNativeReviewController } from "./authoritative-native-review-controller.js";
import {
  reconcileNativeProposalRefs,
  reconcileRegisteredNativeProposals
} from "./native-proposal-reconciler.js";
import { createNativeProposalReconciliationLoop } from "./native-proposal-reconciliation-loop.js";
import { parseNativeGitProjectRegistrars } from "./native-project-registrar-http.js";
import { executeNativeProjectPreparation } from "./native-project-registration.js";
import { NativeGitBundleServerError, type NativeGitBundleServer, type NativeGitBundleServerOptions,
  type NativeGitPreparedProject } from "./native-bundle-server-types.js";
import { createNativeHumanReviewerService } from "./native-human-reviewer-http.js";
import { deriveAuthoritativeOrdinaryExecutionDescriptor } from "./authoritative-ordinary-execution-descriptor.js";
import { deriveAuthoritativeQemuExecutionDescriptor } from "./authoritative-qemu-execution-descriptor.js";
import { createAuthoritativeNativeEventDispatcher,
  type AuthoritativeNativeEventDispatcher } from "./authoritative-native-event-dispatcher.js";
import { createAuthoritativeNativeQemuEventDispatcher } from "./authoritative-native-qemu-event-dispatcher.js";
import { nativeBundleKnownCredentials } from "./native-bundle-known-credentials.js";
import { createOrdinaryReservationClaimVerifier } from "./ordinary-reservation-claim.js";
import { createNativeBundleOrdinaryServices } from "./native-bundle-ordinary-services.js";
import { currentOrdinaryTerminalEvidence as readCurrentOrdinaryTerminalEvidence }
  from "./current-ordinary-terminal-evidence.js";
import { createNativeBundleHttpServer } from "./native-bundle-http-server.js";
import { createNativeQemuAuthorityService } from "./native-qemu-authority-http.js";
import { createNativeHostPromoterService } from "./native-host-promoter-http.js";
import { promoteInstalledNativeReview } from "./native-installed-promotion.js";
import { createNativeCandidateReadService } from "./native-candidate-read-http.js";

export { NativeGitBundleServerError } from "./native-bundle-server-types.js";
export type {
  AuthoritativeNativeReviewSelector,
  NativeGitBundleServer,
  NativeGitBundleServerOptions,
  NativeGitPreparedProject,
  CurrentOrdinaryTerminalEvidence,
  CurrentOrdinaryTerminalEvidenceSelector
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
  let businessReady = false;
  let proposalReconciliationHealthy = true;
  const rootImportService = createNativeProjectRootImportService({
    activated: () => businessReady,
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
    workflowCompiler: options.workflowCompiler,
    activated: () => activated,
    activationTokenDigest,
    expectedGenerationId: options.expectedGenerationId,
    gitExecutable: config.gitExecutable,
    gitIdentity,
    state
  };
  const reviewController = createAuthoritativeNativeReviewController({
    available: () => !closed,
    operations: transportOperations,
    runtime: authoritativeRuntime,
    ...(options.authoritativeReviewHooks === undefined ? {} : { hooks: options.authoritativeReviewHooks })
  });
  let eventDispatcher: AuthoritativeNativeEventDispatcher;
  try {
    const ordinaryDispatcher = await createAuthoritativeNativeEventDispatcher({
      webhook: config.ordinaryCi.webhook,
      state,
      stateDirectory: options.stateDirectory,
      generationId: options.expectedGenerationId,
      httpClient: identityHttpClient,
      serialize: reviewController.run,
      ...(options.deliveryFaults === undefined ? {} : { deliveryFaults: options.deliveryFaults })
    });
    const qemuDispatcher = config.qemuCi === undefined ? undefined
      : await createAuthoritativeNativeQemuEventDispatcher({ dependency: config.qemuCi, state,
        stateDirectory: options.stateDirectory, httpClient: identityHttpClient, serialize: reviewController.run,
        ...(options.deliveryFaults === undefined ? {} : { deliveryFaults: options.deliveryFaults }) });
    eventDispatcher = qemuDispatcher === undefined ? ordinaryDispatcher : {
      start() { ordinaryDispatcher.start(); qemuDispatcher.start(); },
      wake() { ordinaryDispatcher.wake(); qemuDispatcher.wake(); },
      healthy() { return ordinaryDispatcher.healthy() && qemuDispatcher.healthy(); },
      async close() { const settled = await Promise.allSettled([ordinaryDispatcher.close(), qemuDispatcher.close()]);
        const rejected = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
        if (rejected !== undefined) throw rejected.reason; }
    };
  } catch (error) {
    await state.owner.release();
    throw error;
  }
  const reconcileAllProposals = async (): Promise<void> => {
    await reconcileRegisteredNativeProposals(authoritativeRuntime, options.authoritativeReviewHooks ?? {});
    eventDispatcher.wake();
  };
  const proposalReconciliation = createNativeProposalReconciliationLoop({
    reconcile: () => reviewController.run(reconcileAllProposals),
    unavailable() {
      proposalReconciliationHealthy = false;
      businessReady = false;
    }
  });
  const reconcileProposalRefs = async (projectId: string, proposalRefs: readonly string[]): Promise<void> => {
    try {
      await reconcileNativeProposalRefs(
        authoritativeRuntime, projectId, proposalRefs, options.authoritativeReviewHooks ?? {}
      );
      eventDispatcher.wake();
    } catch (error) {
      proposalReconciliation.wake();
      throw error;
    }
  };
  if (activated) {
    try {
      await reviewController.run(reconcileAllProposals);
      businessReady = true;
    } catch (error) {
      await eventDispatcher.close();
      await state.owner.release();
      throw error;
    }
  }
  const rootReadService = createNativeProjectRootReadService({
    activated: () => businessReady,
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
    activated: () => businessReady,
    activationTokenDigest,
    expectedGenerationId: options.expectedGenerationId,
    gitExecutable: config.gitExecutable,
    gitIdentity,
    issuers: config.workspaceWriteIssuers,
    knownCredentials: nativeBundleKnownCredentials(config, registrars, "workspace-write-issuers"),
    now: options.workspaceWriteLeaseClock ?? Date.now,
    operations: transportOperations,
    reconcileProposalRefs,
    serializeReceive: reviewController.run,
    ...(options.workspaceWriteLeaseHooks === undefined ? {} : { hooks: options.workspaceWriteLeaseHooks }),
    state,
    stateDirectory: options.stateDirectory
  });
  const knownCredentials = nativeBundleKnownCredentials(config, registrars);
  const candidateReadService = createNativeCandidateReadService({ config, runtime: authoritativeRuntime,
    gitExecutable: config.gitExecutable, stateDirectory: options.stateDirectory,
    now: options.rootReadLeaseClock ?? Date.now, serialize: reviewController.run });
  const ordinaryServices = createNativeBundleOrdinaryServices({
    attemptHooks: options.nativeOrdinaryAttemptHooks,
    config,
    httpClient: identityHttpClient,
    knownCredentials,
    runtime: authoritativeRuntime,
    serialize: reviewController.run,
    verifyClaim: createOrdinaryReservationClaimVerifier({
      config: config.ordinaryCi,
      generationId: options.expectedGenerationId,
      httpClient: identityHttpClient
    }).verify
  });
  const qemuAuthorityService = createNativeQemuAuthorityService({ config, knownCredentials,
    runtime: authoritativeRuntime, serialize: reviewController.run });
  const humanReviewerService = createNativeHumanReviewerService({
    config,
    knownCredentials,
    serialize: reviewController.run,
    ...(options.nativeHumanReviewerHooks === undefined ? {} : { hooks: options.nativeHumanReviewerHooks }),
    runtime: authoritativeRuntime
  });
  const hostPromoterService = createNativeHostPromoterService({ config, knownCredentials,
    runtime: authoritativeRuntime,
    promote: (projectId, reviewId) => reviewController.run(() => promoteInstalledNativeReview({
      config,
      runtime: authoritativeRuntime,
      stateDirectory: options.stateDirectory,
      currentOrdinaryEvidence: (selector) => readCurrentOrdinaryTerminalEvidence({
        config: config.ordinaryCi,
        httpClient: identityHttpClient,
        runtime: authoritativeRuntime,
        serialize: reviewController.run,
        alreadySerialized: true
      }, selector),
      ...(options.nativePromotionHooks === undefined ? {} : { hooks: options.nativePromotionHooks })
    }, projectId, reviewId))
  });
  const prepareProject = (generationId: string, ownerHostId: string, input: unknown): Promise<NativeGitPreparedProject> => {
    if (closed) return Promise.reject(new NativeGitBundleServerError("native Git bundle server is closed"));
    const operation = preparationQueue.then(async () => {
      if (!businessReady || generationId !== options.expectedGenerationId) {
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
    options,
    registrars,
    rootImportService,
    rootReadService,
    state,
    workspaceWriteService,
    readiness: {
      activated: () => activated,
      activationTokenDigest,
      expectedGenerationId: options.expectedGenerationId,
      gitExecutable: config.gitExecutable,
      gitIdentity,
      issuers: config.workspaceWriteIssuers,
      state,
      stateDirectory: options.stateDirectory
    },
    humanReviewerService,
    hostPromoterService,
    candidateReadService,
    rootCiProofService: ordinaryServices.rootCiProofService,
    ordinaryAttemptService: ordinaryServices.ordinaryAttemptService,
    ordinaryStatusService: ordinaryServices.ordinaryStatusService,
    qemuAuthorityService,
    deliveryHealthy: () => eventDispatcher.healthy() && proposalReconciliationHealthy,
    activated: () => businessReady,
    async activate() {
      if (businessReady) return;
      activated = true;
      await reviewController.run(reconcileAllProposals);
      businessReady = true;
    },
    prepareProject
  });
  const server = createNativeBundleHttpServer({
    closed: () => closed,
    handle,
    onListening: eventDispatcher.start
  });
  const close = createNativeBundleShutdown({ server, eventDispatcher, state,
    stopAdmission() {
      closed = true;
      rootReadService.close();
      candidateReadService.close();
      workspaceWriteService.close();
    },
    async drainOperations() {
      const transportClosed = transportOperations.close();
      await proposalReconciliation.close();
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
    async currentOrdinaryTerminalEvidence(input) {
      return readCurrentOrdinaryTerminalEvidence({
        config: config.ordinaryCi,
        httpClient: identityHttpClient,
        runtime: authoritativeRuntime,
        serialize: reviewController.run
      }, input);
    },
    close
  };

}
