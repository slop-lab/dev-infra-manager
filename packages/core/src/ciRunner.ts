import { randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import { MissingRecordError, UserError } from "./errors.js";
import { ciRunnerContainerPlan, removeCiRunnerContainer, startCiRunnerContainer, stopCiRunnerContainer } from "./ciRunnerContainer.js";
import { giteaCiCoordinator } from "./giteaCiCoordinator.js";
import { LifecycleState, validateLifecycleName } from "./lifecycleState.js";
import { showProject } from "./projectRegistry.js";
import type { CiRunnerExecutorKind, CiRunnerRecord, CiRunnerResources, LifecycleOptions, QemuCiRunnerExecutor, SysboxCiRunnerExecutor } from "./lifecycleTypes.js";
import type { StreamingCommandRunner } from "./types.js";
import { ensureCiRunnerVolume, removeCiRunnerVolume } from "./ciRunnerVolume.js";
import { ciRunnerLabels, loadCiRunnerConfig, qemuCiRunnerLabelNames } from "./ciRunnerConfig.js";
import { probeCiRunnerWorkloads } from "./ciRunnerProbe.js";
import { ciRunnerQemuCommonCacheVolumeName, prepareQemuProjectHookFromSnapshot, removeQemuProjectImageState, restorePersistedQemuProjectHook } from "./qemuCiRunnerImage.js";
import { ciRunnerQemuDispatchVolumeName, ciRunnerQemuProjectCacheVolumeName, ciRunnerQemuRunnerName, ciRunnerQemuSupervisorLaunchArgs,
  ciRunnerQemuSupervisorName, ciRunnerQemuVolumeName, ciRunnerQemuVolumeDeletionPlans, qemuMemoryMiB } from "./qemuCiRunnerLifecycle.js";
import { prepareQemuCiRunnerSupervisorImage, qemuCiRunnerProductionImageKeys } from "./qemuCiRunnerSupervisorImage.js";
import { resolveProtectedRootSnapshotLocked } from "./protectedRootSnapshot.js";
import { configureSysboxRegistryMirror, ensureRegistryCache } from "./registryCache.js";
import { BUILTIN_CI_RUNNER_DEFAULTS, detectCiRunnerKvm, effectiveCiRunnerResources, effectiveQemuCiRunnerResources } from "./ciRunnerResources.js";
import { prepareQemuBacklogReplay } from "./qemuCiRunnerBacklog.js";
import { prepareSharedQemuBacklogReplay } from "./qemuCiRunnerBacklog.js";
import { qemuSchedulerConnection } from "./qemuSchedulerConnection.js";
import { assertPersistedQemuScheduler, assertQemuSchedulerTopology } from "./qemuCiRunnerShared.js";
import { ciRunnerContainerArgs, ciRunnerContainerName, ciRunnerProviderName, ciRunnerVolumeName, removeSysboxRegistration,
  resolveSysboxRunnerImage, sysboxRegistrationExists } from "./sysboxCiRunnerLifecycle.js";

export { BUILTIN_CI_RUNNER_DEFAULTS, ciRunnerContainerArgs, ciRunnerContainerName, ciRunnerVolumeName, detectCiRunnerKvm, effectiveCiRunnerResources, effectiveQemuCiRunnerResources };
export { ciRunnerQemuDispatchVolumeName, ciRunnerQemuRunnerName, ciRunnerQemuSupervisorName, ciRunnerQemuVolumeName, qemuMemoryMiB } from "./qemuCiRunnerLifecycle.js";

export interface CreateCiRunnerInput { project: string; name: string; executor: CiRunnerExecutorKind; resources?: Partial<CiRunnerResources> }
interface CiRunnerIdentity { project: string; name: string }

export async function createCiRunner(runner: StreamingCommandRunner, options: LifecycleOptions, input: CreateCiRunnerInput): Promise<CiRunnerRecord> {
  return reconcileCiRunner(runner, options, input, "create");
}

export async function restartCiRunner(runner: StreamingCommandRunner, options: LifecycleOptions, input: CiRunnerIdentity): Promise<CiRunnerRecord> {
  return reconcileCiRunner(runner, options, input, "restart");
}

export async function startCiRunner(runner: StreamingCommandRunner, options: LifecycleOptions, input: CiRunnerIdentity): Promise<CiRunnerRecord> {
  return reconcileCiRunner(runner, options, input, "start");
}

async function reconcileCiRunner(runner: StreamingCommandRunner, options: LifecycleOptions, input: CiRunnerIdentity & { executor?: CiRunnerExecutorKind; resources?: Partial<CiRunnerResources> }, mode: "create" | "restart" | "start"): Promise<CiRunnerRecord> {
  const projectName = validateLifecycleName(input.project, "project");
  const name = validateLifecycleName(input.name, "CI runner");
  const state = new LifecycleState(options.stateRoot);
  const releaseProject = await state.acquireProjectLock(projectName); let projectLockHeld = true;
  try {
    const release = await state.acquireCiRunnerLock(projectName);
    try {
    const project = await state.readProject(projectName);
    if (!project.rootRepositoryAlias) throw new UserError(`project '${projectName}' has no root repository`);
    const existing = await readOptional(state, projectName, name);
    if (mode === "create" && existing) {
      throw new UserError(`CI runner '${projectName}/${name}' already exists`);
    }
    if (mode !== "create" && !existing) {
      throw new UserError(`CI runner '${projectName}/${name}' not found`);
    }
    if (mode === "start" && existing?.executor.phase !== "stopped") {
      throw new UserError(`CI runner '${projectName}/${name}' is not stopped`);
    }
    const executorKind = input.executor ?? existing?.executor.kind;
    if (!executorKind) throw new UserError("creating a CI runner requires an executor");
    if (executorKind === "qemu" && input.resources?.pidsLimit !== undefined) {
      throw new UserError("process limits apply only to the sysbox CI executor");
    }
    const scheduler = executorKind === "qemu" ? await qemuSchedulerConnection(options, project) : undefined;
    if (existing?.executor.kind === "qemu") assertPersistedQemuScheduler(existing, scheduler);
    if (mode === "start" && existing?.executor.kind === "sysbox") {
      await releaseProject();
      projectLockHeld = false;
      await startCiRunnerContainer(runner, ciRunnerContainerPlan(existing, existing.executor));
      return saveExecutor(state, existing, ready(existing.executor));
    }
    if (mode === "start" && existing?.executor.kind === "qemu") {
      await releaseProject(); projectLockHeld = false;
      if (!await detectCiRunnerKvm()) throw new UserError("the qemu CI executor requires x86-64 and host /dev/kvm access");
      const projectHook = await restorePersistedQemuProjectHook({ stateRoot: options.stateRoot, projectId: existing.projectId, provenance: existing.executor.projectHook });
      const executor: QemuCiRunnerExecutor = { ...existing.executor, phase: "creating", updatedAt: new Date().toISOString() };
      assertQemuSchedulerTopology(await state.listCiRunners(), projectName, scheduler, name);
      await removeCiRunnerContainer(runner, ciRunnerContainerPlan(existing, existing.executor));
      let record = await saveExecutor(state, existing, executor);
      const webhookUrl = ciRunnerQemuWebhookUrl(executor);
      try {
        await ensureRegistryCache(runner, options.stateRoot);
        await ensureCiRunnerVolume(runner, { name: executor.volumeName, resource: "ci-qemu-data", project: projectName, projectId: record.projectId });
        if (scheduler === undefined) await ensureCiRunnerVolume(runner, { name: ciRunnerQemuDispatchVolumeName(projectName), resource: "ci-qemu-dispatch", project: projectName, projectId: record.projectId });
        await ensureCiRunnerVolume(runner, { name: ciRunnerQemuCommonCacheVolumeName(), resource: "ci-qemu-common-cache" });
        await ensureCiRunnerVolume(runner, { name: ciRunnerQemuProjectCacheVolumeName(projectName), resource: "ci-qemu-project-cache", project: projectName, projectId: record.projectId });
        if (scheduler === undefined) await giteaCiCoordinator.removeWorkflowJobWebhook(runner, options, project, webhookUrl);
        await giteaCiCoordinator.removeRunner(runner, options, project, ciRunnerQemuRunnerName(projectName, name, scheduler?.hostId));
        const imageKeys = qemuCiRunnerProductionImageKeys({ projectId: record.projectId, hook: executor.projectHook });
        const registration = await giteaCiCoordinator.prepareRunner(runner, options, project);
        const authorization = `Bearer ${randomBytes(32).toString("hex")}`;
        const started = await runner.run("docker", ciRunnerQemuSupervisorLaunchArgs({ record, executor, registration, authorization, kvmGroupId: () => statSync("/dev/kvm").gid, ...imageKeys, projectHook, ...(scheduler === undefined ? {} : { scheduler }) }));
        if (started.exitCode !== 0) throw new UserError(`failed to start QEMU CI runner '${projectName}/${name}': ${started.stderr.trim()}`);
        const replayQueuedJob = scheduler === undefined
          ? await prepareQemuBacklogReplay({ runner, record, executor, authorization })
          : await prepareSharedQemuBacklogReplay({ runner, record, executor, authorization }, scheduler);
        await giteaCiCoordinator.ensureWorkflowJobWebhook(runner, options, project, scheduler === undefined
          ? { url: webhookUrl, authorizationHeader: authorization, replayQueuedJob }
          : { url: scheduler.webhookUrl, authorizationHeader: `Bearer ${scheduler.webhookToken}`, replayQueuedJob, central: true });
        record = { ...record, provider: registration.provider };
        return saveExecutor(state, record, ready(executor));
      } catch (error) { await saveExecutor(state, record, failed(executor, error)); throw error; }
    }
    const snapshot = await resolveProtectedRootSnapshotLocked({ runner, options, project });
    const runnerConfig = await loadCiRunnerConfig(snapshot);
    const now = new Date().toISOString();
    let record: CiRunnerRecord;
    if (executorKind === "sysbox") {
      await releaseProject();
      projectLockHeld = false;
      const hostImage = await resolveSysboxRunnerImage(runner, options.stateRoot, options.ciRunnerImage);
      await ensureRegistryCache(runner, options.stateRoot);
      const previous = existing?.executor.kind === "sysbox" ? existing.executor : undefined;
      const effective = previous && input.resources === undefined && !previous.inheritsResources ? { resources: previous.resources, inheritsResources: false } : effectiveCiRunnerResources(options, input.resources);
      const labels = [...runnerConfig.config.workloads.ordinary.labels];
      const executor: SysboxCiRunnerExecutor = { kind: "sysbox", phase: "creating", containerName: ciRunnerContainerName(projectName, name), volumeName: ciRunnerVolumeName(projectName, name), image: hostImage, runtime: options.ciRunnerRuntime, ...effective, labels, updatedAt: now };
      record = await saveExecutor(state, {
        ...(existing ?? newRecord({ project, name, executor, config: runnerConfig.provenance, now })),
        config: runnerConfig.provenance
      }, executor);
      try {
        await removeCiRunnerContainer(runner, ciRunnerContainerPlan(record, executor));
        await ensureCiRunnerVolume(runner, { name: executor.volumeName, resource: "ci-runner-data", project: projectName, projectId: project.id });
        await configureSysboxRegistryMirror(runner, executor.volumeName);
        await probeCiRunnerWorkloads(runner, {
          config: runnerConfig.config,
          hostImage: executor.image,
          runtime: executor.runtime,
          projectName,
          projectId: project.id,
          capacityName: name,
          executorKind
        });
        const registration = await giteaCiCoordinator.prepareRunner(runner, options, project);
        const providerRunnerName = ciRunnerProviderName(projectName, name, registration.hostId);
        if (previous?.providerRunnerName !== undefined && previous.providerRunnerName !== providerRunnerName) {
          throw new UserError(`CI runner '${projectName}/${name}' external host identity changed`);
        }
        if (await sysboxRegistrationExists(runner, executor.volumeName)) {
          await giteaCiCoordinator.removeRunner(
            runner,
            options,
            project,
            previous?.providerRunnerName ?? providerRunnerName
          );
          await removeSysboxRegistration(runner, executor.volumeName);
        }
        const registeredExecutor = { ...executor, providerRunnerName } satisfies SysboxCiRunnerExecutor;
        record = await saveExecutor(state, record, registeredExecutor);
        const started = await runner.run("docker", ciRunnerContainerArgs({
          record,
          executor: registeredExecutor,
          labels: ciRunnerLabels(runnerConfig.config),
          registration,
          registryMirror: true
        }));
        if (started.exitCode !== 0) throw new UserError(`failed to start sysbox CI runner '${projectName}/${name}': ${started.stderr.trim()}`);
        record = { ...record, provider: registration.provider };
        return saveExecutor(state, record, ready(registeredExecutor));
      } catch (error) { await saveExecutor(state, record, failed(executor, error)); throw error; }
    }
    if (!await detectCiRunnerKvm()) throw new UserError("the qemu CI executor requires x86-64 and host /dev/kvm access");
    const previous = existing?.executor.kind === "qemu" ? existing.executor : undefined;
    const effective = previous && input.resources === undefined && !previous.inheritsResources
      ? { resources: previous.resources, inheritsResources: false }
      : effectiveQemuCiRunnerResources(options, input.resources);
    const projectHook = await prepareQemuProjectHookFromSnapshot({ stateRoot: options.stateRoot, snapshot });
    assertQemuSchedulerTopology(await state.listCiRunners(), projectName, scheduler, name);
    await releaseProject();
    projectLockHeld = false;
    const hostImage = await resolveSysboxRunnerImage(runner, options.stateRoot, options.ciRunnerImage);
    const supervisorImage = await prepareQemuCiRunnerSupervisorImage(runner, options.stateRoot);
    const executor: QemuCiRunnerExecutor = {
      kind: "qemu", phase: "creating", supervisorName: ciRunnerQemuSupervisorName(projectName, name),
      volumeName: ciRunnerQemuVolumeName(projectName, name), image: supervisorImage,
      projectHook: { sourceRef: projectHook.sourceRef, sourceCommit: projectHook.sourceCommit, kind: projectHook.kind, digest: projectHook.digest },
      ...effective,
      labels: [...qemuCiRunnerLabelNames(runnerConfig.config)],
      jobImage: runnerConfig.config.workloads.integration.image,
      ...(scheduler === undefined ? {} : { scheduler: { projectId: scheduler.projectId, hostId: scheduler.hostId } }),
      updatedAt: now
    };
    record = {
      ...(existing ?? newRecord({ project, name, executor, config: runnerConfig.provenance, now })),
      config: runnerConfig.provenance,
      executor
    };
    await removeCiRunnerContainer(runner, ciRunnerContainerPlan(record, executor));
    record = await saveExecutor(state, record, executor);
    const webhookUrl = ciRunnerQemuWebhookUrl(executor);
    try {
      await ensureRegistryCache(runner, options.stateRoot);
      if (scheduler === undefined) await giteaCiCoordinator.removeWorkflowJobWebhook(runner, options, project, webhookUrl);
      await giteaCiCoordinator.removeRunner(runner, options, project, ciRunnerQemuRunnerName(projectName, name, scheduler?.hostId));
      await ensureCiRunnerVolume(runner, { name: executor.volumeName, resource: "ci-qemu-data", project: projectName, projectId: project.id });
      if (scheduler === undefined) await ensureCiRunnerVolume(runner, { name: ciRunnerQemuDispatchVolumeName(projectName), resource: "ci-qemu-dispatch", project: projectName, projectId: project.id });
      await ensureCiRunnerVolume(runner, { name: ciRunnerQemuCommonCacheVolumeName(), resource: "ci-qemu-common-cache" });
      await ensureCiRunnerVolume(runner, { name: ciRunnerQemuProjectCacheVolumeName(projectName), resource: "ci-qemu-project-cache", project: projectName, projectId: project.id });
      const imageKeys = qemuCiRunnerProductionImageKeys({ projectId: project.id, hook: executor.projectHook });
      await probeCiRunnerWorkloads(runner, {
        config: runnerConfig.config,
        hostImage,
        runtime: options.ciRunnerRuntime,
        projectName,
        projectId: project.id,
        capacityName: name,
        executorKind
      });
      const registration = await giteaCiCoordinator.prepareRunner(runner, options, project);
      const authorization = `Bearer ${randomBytes(32).toString("hex")}`;
      const started = await runner.run("docker", ciRunnerQemuSupervisorLaunchArgs({
        record,
        executor,
        registration,
        authorization,
        kvmGroupId: () => statSync("/dev/kvm").gid,
        ...imageKeys,
        projectHook,
        ...(scheduler === undefined ? {} : { scheduler })
      }));
      if (started.exitCode !== 0) throw new UserError(`failed to start QEMU CI runner '${projectName}/${name}': ${started.stderr.trim()}`);
      const replayQueuedJob = scheduler === undefined
        ? await prepareQemuBacklogReplay({ runner, record, executor, authorization })
      : await prepareSharedQemuBacklogReplay({ runner, record, executor, authorization }, scheduler);
      await giteaCiCoordinator.ensureWorkflowJobWebhook(runner, options, project, scheduler === undefined
        ? { url: webhookUrl, authorizationHeader: authorization, replayQueuedJob }
        : { url: scheduler.webhookUrl, authorizationHeader: `Bearer ${scheduler.webhookToken}`, replayQueuedJob, central: true });
      record = { ...record, provider: registration.provider };
      return saveExecutor(state, record, ready(executor));
    } catch (error) { await saveExecutor(state, record, failed(executor, error)); throw error; }
    } finally { await release(); }
  } finally {
    if (projectLockHeld) await releaseProject();
  }
}

export async function showCiRunner(options: LifecycleOptions, project: string, name: string): Promise<CiRunnerRecord> { return new LifecycleState(options.stateRoot).readCiRunner(validateLifecycleName(project, "project"), validateLifecycleName(name, "CI runner")); }
export async function listCiRunners(options: LifecycleOptions): Promise<CiRunnerRecord[]> { return new LifecycleState(options.stateRoot).listCiRunners(); }

export async function stopCiRunner(runner: StreamingCommandRunner, options: LifecycleOptions, project: string, name: string): Promise<CiRunnerRecord> {
  const state = new LifecycleState(options.stateRoot); project = validateLifecycleName(project, "project"); name = validateLifecycleName(name, "CI runner");
  const releaseProject = await state.acquireProjectLock(project);
  try {
    const release = await state.acquireCiRunnerLock(project);
    try {
      const projectRecord = await state.readProject(project); const record = await state.readCiRunner(project, name); const executor = record.executor;
      await stopCiRunnerContainer(runner, ciRunnerContainerPlan(record, executor));
      if (executor.kind === "qemu" && executor.scheduler === undefined) await giteaCiCoordinator.removeWorkflowJobWebhook(runner, options, projectRecord, ciRunnerQemuWebhookUrl(executor));
      const updated = await saveExecutor(state, record, { ...executor, phase: "stopped", updatedAt: new Date().toISOString() } as typeof executor);
      if (executor.kind === "qemu") await giteaCiCoordinator.reconcileWorkflowJobWebhookTargets(runner, options);
      return updated;
    } finally { await release(); }
  } finally { await releaseProject(); }
}

export async function deleteCiRunner(runner: StreamingCommandRunner, options: LifecycleOptions, project: string, name: string): Promise<void> {
  const state = new LifecycleState(options.stateRoot); project = validateLifecycleName(project, "project"); name = validateLifecycleName(name, "CI runner");
  const release = await state.acquireCiRunnerLock(project);
  try {
    const record = await state.readCiRunner(project, name); const executor = record.executor; const projectRecord = await showProject(options, project);
    if (executor.kind === "sysbox") {
      await removeCiRunnerContainer(runner, ciRunnerContainerPlan(record, executor));
      await giteaCiCoordinator.removeRunner(
        runner,
        options,
        projectRecord,
        executor.providerRunnerName ?? executor.containerName
      );
      await removeCiRunnerVolume(runner, { name: executor.volumeName, resource: "ci-runner-data", project, projectId: record.projectId }, `sysbox CI runner data for '${project}/${name}'`);
    } else {
      await removeCiRunnerContainer(runner, ciRunnerContainerPlan(record, executor));
      if (executor.scheduler === undefined) await giteaCiCoordinator.removeWorkflowJobWebhook(runner, options, projectRecord, ciRunnerQemuWebhookUrl(executor));
      await giteaCiCoordinator.removeRunner(runner, options, projectRecord, ciRunnerQemuRunnerName(project, name, executor.scheduler?.hostId));
      const remainingCapacityNames = (await state.listCiRunners()).filter((candidate) => candidate.projectName === project && candidate.name !== name && candidate.executor.kind === "qemu").map((candidate) => candidate.name);
      const volumes = ciRunnerQemuVolumeDeletionPlans({ project, projectId: record.projectId, capacityName: name, remainingCapacityNames });
      for (const volume of volumes) await removeCiRunnerVolume(runner, volume, `QEMU CI runner resource for '${project}/${name}'`);
      if (remainingCapacityNames.length === 0) await removeQemuProjectImageState(options.stateRoot, record.projectId);
      await giteaCiCoordinator.reconcileWorkflowJobWebhookTargets(runner, options, { project, name });
    }
    await state.removeCiRunner(project, name);
  } finally { await release(); }
}

async function readOptional(state: LifecycleState, project: string, name: string): Promise<CiRunnerRecord | undefined> { try { return await state.readCiRunner(project, name); } catch (error) { if (error instanceof MissingRecordError) return undefined; throw error; } }
function newRecord(input: { project: { id: string; name: string }; name: string; executor: SysboxCiRunnerExecutor | QemuCiRunnerExecutor; config: CiRunnerRecord["config"]; now: string }): CiRunnerRecord { return { schemaVersion: 8, name: input.name, projectId: input.project.id, projectName: input.project.name, provider: "pending", config: input.config, executor: input.executor, createdAt: input.now, updatedAt: input.now }; }
async function saveExecutor(state: LifecycleState, record: CiRunnerRecord, executor: SysboxCiRunnerExecutor | QemuCiRunnerExecutor): Promise<CiRunnerRecord> { const updated = { ...record, executor, updatedAt: new Date().toISOString() }; await state.writeCiRunner(updated); return updated; }
function ready<T extends SysboxCiRunnerExecutor | QemuCiRunnerExecutor>(executor: T): T { const value = { ...executor, phase: "ready", updatedAt: new Date().toISOString() }; delete value.error; return value; }
function failed<T extends SysboxCiRunnerExecutor | QemuCiRunnerExecutor>(executor: T, error: unknown): T { return { ...executor, phase: "error", updatedAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) }; }

function ciRunnerQemuWebhookUrl(executor: QemuCiRunnerExecutor): string { return `http://${executor.supervisorName}:8080/workflow-job`; }
