import type { Server } from "node:http";
import { UserError } from "./errors.js";
import { configuredExternalGiteaConnection } from "./giteaExternalConnection.js";
import { withHostRuntimeAdmission } from "./hostAdminAdmission.js";
import { LifecycleState, validateLifecycleName } from "./lifecycleState.js";
import type { GiteaProjectBinding, LifecycleOptions } from "./lifecycleTypes.js";
import {
  acknowledgeOrdinaryPoolRecovery,
  assertOrdinaryPoolServiceIdentity,
  claimOrdinaryPoolJob,
  prepareOrdinaryPoolGiteaRunner,
  releaseOrdinaryPoolClaim,
  renewOrdinaryPoolClaim
} from "./ordinaryCiPoolClient.js";
import { readOrdinaryCiPoolConnection, readOrdinaryCiPoolServiceConfig } from "./ordinaryCiPoolConfig.js";
import { configuredOrdinaryCiPoolServer } from "./ordinaryCiPoolService.js";
import { ensureRegistryCache } from "./registryCache.js";
import { resolveSysboxRunnerImage } from "./sysboxCiRunnerLifecycle.js";
import type { StreamingCommandRunner } from "./types.js";
import {
  assertOrdinaryPoolCapacityAvailable,
  recoverOrdinaryPoolClaim,
  runOrdinaryPoolClaim,
  type OrdinaryPoolClaim
} from "./ordinaryCiPoolWorker.js";

export type OrdinaryPoolCapacityResult =
  | { readonly status: "idle" }
  | { readonly status: "completed"; readonly claim: OrdinaryPoolClaim };

const IDLE_POLL_MILLISECONDS = 1_000;

export async function runOrdinaryCiPoolService(file: string, signal?: AbortSignal): Promise<void> {
  const configured = await readOrdinaryCiPoolServiceConfig(file);
  const server = configuredOrdinaryCiPoolServer(configured.pool);
  await listen(server, configured.listen.host, configured.listen.port);
  await new Promise<void>((resolve, reject) => {
    const close = () => {
      server.close((error) => error === undefined ? resolve() : reject(error));
      server.closeAllConnections();
    };
    if (signal?.aborted) close();
    else signal?.addEventListener("abort", close, { once: true });
    server.once("error", reject);
  });
}

export async function runOrdinaryCiPoolCapacityOnce(
  runner: StreamingCommandRunner,
  options: LifecycleOptions,
  capacityInput: string,
  signal?: AbortSignal
): Promise<OrdinaryPoolCapacityResult> {
  return withHostRuntimeAdmission(
    options,
    () => runOrdinaryCiPoolCapacityOnceAdmitted(runner, options, capacityInput, signal)
  );
}

async function runOrdinaryCiPoolCapacityOnceAdmitted(
  runner: StreamingCommandRunner,
  options: LifecycleOptions,
  capacityInput: string,
  signal?: AbortSignal
): Promise<OrdinaryPoolCapacityResult> {
  const capacity = validateLifecycleName(capacityInput, "ordinary CI pool capacity");
  const file = options.ordinaryCiPoolConnection?.file;
  if (file === undefined) throw new UserError("DIM_ORDINARY_CI_POOL_CONNECTION_FILE is required");
  if (options.giteaConnection.kind !== "external") {
    throw new UserError("the ordinary CI pool requires external Gitea with explicit DIM Project bindings");
  }
  const [connection, gitea] = await Promise.all([
    readOrdinaryCiPoolConnection(file),
    configuredExternalGiteaConnection(options.giteaConnection.file)
  ]);
  if (connection.hostId !== gitea.hostId) {
    throw new UserError("ordinary CI pool host identity must match the external Gitea host identity");
  }
  await assertOrdinaryPoolServiceIdentity(connection, signal);
  const state = new LifecycleState(options.stateRoot);
  assertOrdinaryPoolCapacityAvailable(await state.listCiRunners(), capacity);
  const runnerImage = await resolveSysboxRunnerImage(runner, options.stateRoot, options.ciRunnerImage);
  await ensureRegistryCache(runner, options);
  const claimResult = await claimOrdinaryPoolJob(connection, capacity, signal);
  let claim: OrdinaryPoolClaim;
  switch (claimResult.kind) {
    case "idle": return { status: "idle" };
    case "claimed": claim = claimResult.claim; break;
    case "recovery": {
      await recoverOrdinaryPoolClaim(runner, {
        hostId: connection.hostId,
        capacity,
        claimId: claimResult.claimId,
        projectId: claimResult.projectId
      });
      await acknowledgeOrdinaryPoolRecovery(connection, capacity, claimResult.claimId);
      const replacement = await claimOrdinaryPoolJob(connection, capacity, signal);
      switch (replacement.kind) {
        case "idle": return { status: "idle" };
        case "claimed": claim = replacement.claim; break;
        case "recovery": throw new UserError("ordinary CI pool capacity remained fenced after recovery");
        default: return assertNever(replacement);
      }
      break;
    }
    default: return assertNever(claimResult);
  }
  try {
    enrolledBinding(gitea.projectBindings, claim);
    if (claim.serviceId !== connection.expectedServiceId) {
      throw new UserError("ordinary CI pool claim service identity does not match the reviewed host connection");
    }
    if (claim.jobImage !== connection.expectedJobImage) {
      throw new UserError("ordinary CI pool claim job image does not match the reviewed host connection");
    }
  } catch (error) {
    await releaseOrdinaryPoolClaim(connection, claim);
    throw error;
  }
  await runOrdinaryPoolClaim({
    runner,
    prepareRegistration: () => prepareOrdinaryPoolGiteaRunner(runner, options, claim, gitea.hostId),
    renewClaim: (active, renewSignal) => renewOrdinaryPoolClaim(connection, active, renewSignal),
    releaseClaim: (completed) => releaseOrdinaryPoolClaim(connection, completed)
  }, {
    claim,
    hostId: connection.hostId,
    capacity,
    runnerImage,
    runnerRuntime: options.ciRunnerRuntime,
    resources: {
      cpus: options.ciRunnerDefaultCpus,
      memory: options.ciRunnerDefaultMemory,
      pidsLimit: options.ciRunnerDefaultPidsLimit
    },
    ...(signal === undefined ? {} : { signal })
  });
  return { status: "completed", claim };
}

export async function runOrdinaryCiPoolCapacity(
  runner: StreamingCommandRunner,
  options: LifecycleOptions,
  capacity: string,
  signal: AbortSignal
): Promise<void> {
  while (!signal.aborted) {
    try {
      const result = await runOrdinaryCiPoolCapacityOnce(runner, options, capacity, signal);
      if (signal.aborted) return;
      if (result.status === "idle") await waitForNextPoll(signal);
    } catch (error) {
      if (signal.aborted && error === signal.reason) return;
      throw error;
    }
  }
}

function enrolledBinding(
  bindings: Readonly<Record<string, GiteaProjectBinding>>,
  claim: OrdinaryPoolClaim
): GiteaProjectBinding {
  const binding = bindings[claim.projectName];
  if (binding === undefined || binding.id !== claim.projectId || binding.gitNamespace !== claim.organization
    || binding.giteaOrganizationId !== claim.organizationId) {
    throw new UserError(`ordinary CI pool claim Project '${claim.projectName}' is not an enrolled external Gitea binding`);
  }
  return binding;
}

function listen(server: Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => { server.off("error", reject); resolve(); });
  });
}

async function waitForNextPoll(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const stop = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", stop); resolve(); }, IDLE_POLL_MILLISECONDS);
    signal.addEventListener("abort", stop, { once: true });
  });
}

function assertNever(value: never): never {
  throw new UserError(`unhandled ordinary CI pool result: ${String(value)}`);
}
