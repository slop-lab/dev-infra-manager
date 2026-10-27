import { repositoryOwnedRefs } from "./extension-refs.js";
import { readNativeProposalRefs } from "./native-proposal-reconciler.js";
import { readEffectiveRepositoryPolicy } from "./repository-policy-state.js";
import { refUpdatePolicies, refUpdatePolicyRevision } from "./ref-update-policies.js";
import { lstat, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { syncDirectory } from "./native-root-import-storage.js";
import { once } from "node:events";
import { parseNativeGitBundleConfig } from "./bundle-config.js";
import { assertBundleToken, assertGenerationId } from "./native-bundle-http.js";
import { createNativeBundleRequestHandler } from "./native-bundle-request-handler.js";
import { initializeNativeBundleRuntime } from "./native-bundle-startup.js";
import { initializeNativeGitBundleState } from "./native-bundle-state.js";
import { createNativeProjectRootImportService } from "./native-project-root-import-http.js";
import { createNativeProjectRootReadService } from "./native-project-root-read-http.js";
import { createRootReadOperationGate } from "./native-root-read-lifecycle.js";
import { createRepositoryMutationQueue } from "./repository-mutation-queue.js";
import { RepositoryAccessError } from "./plugin-api.js";
import { createNativeProjectWorkspaceWriteService } from "./native-project-workspace-write-http.js";
import { parseNativeGitProjectRegistrars } from "./native-project-registrar-http.js";
import { executeNativeProjectPreparation } from "./native-project-registration.js";
import { NativeGitBundleServerError, type NativeGitBundleServer, type NativeGitBundleServerOptions } from "./native-bundle-server-types.js";
import { nativeBundleKnownCredentials } from "./native-bundle-known-credentials.js";
import { createNativeBundleHttpServer } from "./native-bundle-http-server.js";
import { repositoryExtensionFactories, type RepositoryAttachment, type RepositoryExtensionContext } from "./plugin-api.js";
import { readNativeProjectRootImportsFromDatabase } from "./native-project-root-import-transitions.js";
import { NativeProjectRootImportStateError } from "./native-project-root-import-codec.js";
import type { NativeImportedRootPolicy } from "./native-imported-root-policy.js";
export { NativeGitBundleServerError } from "./native-bundle-server-types.js";
export type { NativeGitBundleServer, NativeGitBundleServerOptions, NativeGitPreparedProject } from "./native-bundle-server-types.js";

export async function configuredNativeGitBundleServer(options: NativeGitBundleServerOptions): Promise<NativeGitBundleServer> {
  const config = parseNativeGitBundleConfig(options.config);
  assertBundleToken(options.readinessToken, "readiness"); assertBundleToken(options.activationToken, "activation"); assertGenerationId(options.expectedGenerationId);
  const extensions = options.extensions ?? [];
  const refPolicies = refUpdatePolicies(extensions);
  const factories = repositoryExtensionFactories(extensions);
  if (factories.some((factory) => !/^[a-z][a-z0-9-]{0,63}$/.test(factory.name))) throw new Error("invalid repository extension name");
  if (new Set(factories.map((entry) => entry.name)).size !== factories.length) throw new Error("repository extension names must be unique");
  for (const factory of factories) for (const name of factory.requiresRefUpdatePolicies ?? []) {
    if (!refPolicies.some((provider) => provider.name === name)) throw new Error(`repository extension '${factory.name}' requires ref update policy '${name}'`);
  }
  const policyOwners = factories.filter((entry) => entry.policyName !== undefined);
  if (new Set(policyOwners.map((entry) => entry.policyName)).size !== policyOwners.length) throw new Error("repository policy owners must be unique");
  const registrars = parseNativeGitProjectRegistrars(config.projectRegistrars);
  const knownCredentials = [...nativeBundleKnownCredentials(config, registrars), ...factories.flatMap((entry) => entry.credentials ?? [])];
  const secrets = [options.readinessToken, options.activationToken, ...knownCredentials.flatMap((entry) => [entry.username, entry.password])];
  if (new Set(secrets).size !== secrets.length) throw new Error("repository and extension credentials must be globally distinct");
  options.signal?.throwIfAborted();
  const state = await initializeNativeGitBundleState(options.stateDirectory, options.expectedGenerationId, repositoryOwnedRefs(options.stateDirectory, factories));
  const shutdown = new AbortController();
  const abort = () => shutdown.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", abort, { once: true });
  const attachments: RepositoryAttachment[] = [];
  let closed = false;
  const operations = createRootReadOperationGate(16);
  const mutations = createRepositoryMutationQueue();
  const serialize = mutations.exclusive;
  const read = async <Result>(operation: () => Promise<Result>): Promise<Result> => {
    const release = closed ? undefined : operations.acquire();
    if (release === undefined) throw new RepositoryAccessError(503, "repository read service is busy or unavailable");
    try { return await operation(); } finally { release(); }
  };
  const closeAttachments = async () => {
    const failures: unknown[] = [];
    for (const attachment of [...attachments].reverse()) { try { await attachment.close(); } catch (error) { failures.push(error); } }
    if (failures.length > 0) throw new AggregateError(failures, "repository extension cleanup failed");
  };
  try {
    const startup = await initializeNativeBundleRuntime(config, options, state);
    const { activationTokenDigest, gitIdentity, runtimeConfig } = startup;
    let activated = startup.activated;
    let businessReady = false;
    const runtime = { activated: () => activated, activationTokenDigest, expectedGenerationId: options.expectedGenerationId, gitExecutable: config.gitExecutable, gitIdentity, state };
    let workspaceWriteService: ReturnType<typeof createNativeProjectWorkspaceWriteService> | undefined;
    const context: RepositoryExtensionContext = { runtime, stateDirectory: options.stateDirectory, extensionStateDirectory: join(options.stateDirectory, ".extensions"), signal: shutdown.signal, extensions, knownCredentials, reconcileProposals: async (projectId, repositoryId, refs) => { for (const attachment of attachments) await attachment.onProposals?.(projectId, repositoryId, refs); }, authorizeWorkspaceLease: (request, selector) => {
      if (workspaceWriteService === undefined) throw new Error("workspace lease authorization is unavailable");
      return workspaceWriteService.authorizeWorkspaceLease(request, selector);
    }, available: () => !closed, serialize, mutate: mutations.mutate, read };
    for (const factory of factories) {
      shutdown.signal.throwIfAborted();
      await privateExtensionDirectory(context.extensionStateDirectory);
      const extensionStateDirectory = join(context.extensionStateDirectory, factory.name);
      await privateExtensionDirectory(extensionStateDirectory);
      attachments.push(await factory.attach({ ...context, extensionStateDirectory }));
    }
    const validatePolicy = async (policy: NativeImportedRootPolicy, selector: { readonly projectId: string; readonly repositoryId: string }) => {
      for (const name of Object.keys(policy.extensions)) if (!policyOwners.some((entry) => entry.policyName === name) && !refPolicies.some((entry) => entry.name === name)) throw new NativeProjectRootImportStateError(`repository policy requires an enabled ${name} plugin`);
      try { refUpdatePolicyRevision(policy, refPolicies); for (const attachment of attachments) await attachment.validatePolicy?.(policy, selector); }
      catch (error) { throw new NativeProjectRootImportStateError("repository feature policy is invalid", { cause: error }); }
    };
    for (const imported of readNativeProjectRootImportsFromDatabase(state.database)) await validatePolicy(readEffectiveRepositoryPolicy(state.database, imported.projectId, imported.repositoryId).policy, imported);
    const activate = async () => { if (businessReady) return; activated = true; for (const attachment of attachments) await attachment.activate?.(); businessReady = true; };
    if (activated) await activate();
    const rootImportService = createNativeProjectRootImportService({ activated: () => businessReady, activationTokenDigest, available: () => !closed, expectedGenerationId: options.expectedGenerationId, stateDirectory: options.stateDirectory, state, importers: config.projectRootImporters, knownCredentials, gitExecutable: config.gitExecutable, gitIdentity, validatePolicy, serialize, mutate: mutations.mutate, read, async reconcilePolicy(projectId, repositoryId) { for (const attachment of attachments) await attachment.onPolicyChanged?.(projectId, repositoryId); } });
    const rootReadService = createNativeProjectRootReadService({ activated: () => businessReady, activationTokenDigest, expectedGenerationId: options.expectedGenerationId, gitExecutable: config.gitExecutable, gitIdentity, issuers: config.projectRootReadIssuers, knownCredentials, now: options.rootReadLeaseClock ?? Date.now, operations, ...(options.rootReadLeaseHooks === undefined ? {} : { hooks: options.rootReadLeaseHooks }), state, stateDirectory: options.stateDirectory });
    const activeWorkspaceWriteService = createNativeProjectWorkspaceWriteService({ activated: () => businessReady, activationTokenDigest, expectedGenerationId: options.expectedGenerationId, gitExecutable: config.gitExecutable, gitIdentity, issuers: config.workspaceWriteIssuers, knownCredentials, now: options.workspaceWriteLeaseClock ?? Date.now, operations, reconcileProposalRefs: context.reconcileProposals, mutate: mutations.mutate, read, ...(options.workspaceWriteLeaseHooks === undefined ? {} : { hooks: options.workspaceWriteLeaseHooks }), state, stateDirectory: options.stateDirectory });
    workspaceWriteService = activeWorkspaceWriteService;
    const prepareProject: NativeGitBundleServer["prepareProject"] = (generationId, ownerHostId, input) => serialize(async () => {
      if (!businessReady || generationId !== options.expectedGenerationId) throw new NativeGitBundleServerError("repository preparation requires exact activation");
      return executeNativeProjectPreparation({ database: state.database, stateDirectory: options.stateDirectory, runtimeConfig, generationId, ownerHostId, input });
    });
    const handle = createNativeBundleRequestHandler({ activationTokenDigest, config, gitIdentity, operations, options, registrars, rootImportService, rootReadService, serialize, signal: shutdown.signal, state, stateDirectory: options.stateDirectory, workspaceWriteService: activeWorkspaceWriteService, attachments, knownCredentials,
      ...(options.projectAttachmentHooks === undefined ? {} : { projectAttachmentHooks: options.projectAttachmentHooks }),
      readiness: { activated: () => businessReady, activationTokenDigest, expectedGenerationId: options.expectedGenerationId, gitExecutable: config.gitExecutable, gitIdentity, issuers: config.workspaceWriteIssuers, state, stateDirectory: options.stateDirectory },
      deliveryHealthy: () => attachments.every((entry) => entry.healthy?.() !== false), activated: () => businessReady, activate: () => serialize(activate), prepareProject });
    const server = createNativeBundleHttpServer({ closed: () => closed, handle, onListening() {} });
    let closing: Promise<void> | undefined;
    const close = () => closing ??= (async () => {
      closed = true; shutdown.abort(); rootReadService.close(); activeWorkspaceWriteService.close();
      const failures: unknown[] = [];
      try { await Promise.all([mutations.close(), rootImportService.waitForIdle(), operations.close()]); } catch (error) { failures.push(error); }
      for (const attachment of attachments) {
        try { await attachment.drain?.(); } catch (error) { failures.push(error); }
      }
      try { await closeAttachments(); } catch (error) { failures.push(error); }
      try { if (server.listening) { const stopped = once(server, "close"); server.close(); server.closeAllConnections(); await stopped; } } catch (error) { failures.push(error); }
      try { await state.owner.release(); } catch (error) { failures.push(error); }
      options.signal?.removeEventListener("abort", abort);
      if (failures.length > 0) throw new AggregateError(failures, "repository shutdown failed");
    })();
    return { context, server, prepareProject, close, async listen(host = config.host, port = config.port) { if (closed) throw new Error("repository service is closed"); const listening = once(server, "listening"); server.listen(port, host); await listening; const address = server.address(); if (address === null || typeof address === "string") throw new Error("expected TCP listener"); return `http://${host}:${address.port}`; } };
  } catch (error) {
    closed = true; shutdown.abort(); options.signal?.removeEventListener("abort", abort);
    const cleanups = await Promise.allSettled([closeAttachments(), state.owner.release()]);
    const failures = cleanups.flatMap((entry) => entry.status === "rejected" ? [entry.reason] : []);
    if (failures.length > 0) throw new AggregateError([error, ...failures], "repository startup and cleanup failed");
    throw error;
  }
}

async function privateExtensionDirectory(directory: string): Promise<void> {
  try { await mkdir(directory, { mode: 0o700 }); } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error; }
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== process.getuid?.() || (metadata.mode & 0o777) !== 0o700) throw new Error("repository extension state must be a private owned directory");
  await syncDirectory(directory);
  await syncDirectory(dirname(directory));
}
