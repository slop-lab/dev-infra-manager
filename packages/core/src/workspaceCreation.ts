import { MissingRecordError, UserError } from "./errors.js";
import { ensureGitea, GITEA_NETWORK } from "./gitea.js";
import { LifecycleState, validateLifecycleName } from "./lifecycleState.js";
import type { LifecycleOptions, WorkspaceRecord } from "./lifecycleTypes.js";
import type { RegisteredDimPlugins } from "./plugin.js";
import { assertProjectRepositoriesReady } from "./protectedRootResolution.js";
import { resolveProtectedRootSnapshot } from "./protectedRootSnapshot.js";
import type { StreamingCommandRunner } from "./types.js";
import { resolveRepositorySnapshot } from "./workspaceRepositorySnapshot.js";
import { reconcileProject, setupWorkspaceLocked } from "./workspaceSetup.js";
import { assertSelectedProjectUnchanged } from "./workspaceState.js";
import {
  resolveWorkspaceCapabilities,
  resolveWorkspaceKvm,
  validateRepositoryRefOverrides,
  validateWorkspaceProfiles,
  validateWorkspaceResources
} from "./workspaceValidation.js";

export async function createWorkspace(
  runner: StreamingCommandRunner,
  options: LifecycleOptions,
  input: {
    project: string;
    name: string;
    profiles: string[];
    requiredCapabilities?: string[];
    recommendedCapabilities?: string[];
    repositoryRefs?: string[];
    runtimeBackend: WorkspaceRecord["runtimeBackend"];
    cpuCount?: string;
    memory?: string;
    pidsLimit?: string;
    kvm?: boolean;
    gitUserName?: string;
    gitUserEmail?: string;
  },
  plugins: Pick<RegisteredDimPlugins, "workspaceCapabilityProviders"> = { workspaceCapabilityProviders: new Map() }
): Promise<WorkspaceRecord> {
  const project = validateLifecycleName(input.project, "project");
  const name = validateLifecycleName(input.name, "workspace");
  const profiles = validateWorkspaceProfiles(input.profiles);
  validateWorkspaceResources({
    cpuCount: input.cpuCount ?? options.cpuCount,
    memory: input.memory ?? options.memory,
    pidsLimit: input.pidsLimit ?? options.pidsLimit
  });
  const state = new LifecycleState(options.stateRoot);
  assertProjectRepositoriesReady(await state.readProject(project));
  const selectedRoot = await resolveProtectedRootSnapshot({ runner, options, projectName: project });
  const releaseProject = await state.acquireProjectLock(project);
  try {
    await assertSelectedProjectUnchanged(state, selectedRoot);
    const projectRecord = selectedRoot.project;
    const capabilities = await resolveWorkspaceCapabilities(
      input.requiredCapabilities ?? [], input.recommendedCapabilities ?? [], projectRecord, name,
      input.runtimeBackend, plugins.workspaceCapabilityProviders
    );
    const repositoryRefOverrides = validateRepositoryRefOverrides(input.repositoryRefs ?? [], projectRecord);
    const repo = selectedRoot.repository;
    const now = new Date().toISOString();
    const gitUserName = input.gitUserName ?? process.env.DIM_GIT_USER_NAME ?? `dim/${name}`;
    const gitUserEmail = input.gitUserEmail ?? process.env.DIM_GIT_USER_EMAIL ?? `${name}@dim.invalid`;
    let record: WorkspaceRecord;
    try {
      record = await state.readWorkspace(name);
      if (record.projectId !== projectRecord.id) {
        throw new UserError(`workspace '${name}' is already bound to project '${record.projectName}'`);
      }
      if (record.profiles.join("\0") !== profiles.join("\0")) {
        throw new UserError(`workspace '${name}' already exists with different profiles; use dim workspace update`);
      }
      if (JSON.stringify(record.capabilities ?? []) !== JSON.stringify(capabilities)) {
        throw new UserError(`workspace '${name}' already exists with different capability requests`);
      }
      if (JSON.stringify(record.repositoryRefOverrides ?? {}) !== JSON.stringify(repositoryRefOverrides)) {
        throw new UserError(`workspace '${name}' already exists with different repository ref overrides`);
      }
      if (record.runtimeBackend !== input.runtimeBackend) {
        throw new UserError(`workspace '${name}' already exists with backend '${record.runtimeBackend}'`);
      }
      if (input.kvm !== undefined && record.kvm !== input.kvm) {
        throw new UserError(`workspace '${name}' already exists with KVM ${record.kvm ? "enabled" : "disabled"}`);
      }
      if (
        record.cpuCount !== (input.cpuCount ?? options.cpuCount)
        || record.memory !== (input.memory ?? options.memory)
        || record.pidsLimit !== (input.pidsLimit ?? options.pidsLimit)
      ) {
        throw new UserError(`workspace '${name}' already exists with different resource limits`);
      }
    } catch (error) {
      if (!(error instanceof MissingRecordError)) throw error;
      const kvm = await resolveWorkspaceKvm(input.runtimeBackend, input.kvm);
      const credentials = await ensureGitea(runner, options);
      const repositorySnapshot = await resolveRepositorySnapshot(runner, {
        rootRepositoryAlias: repo.alias,
        rootRequestedRef: selectedRoot.rootRequestedRef,
        rootRef: selectedRoot.rootRef,
        rootCommit: selectedRoot.rootCommit,
        repositoryRefOverrides
      }, projectRecord, credentials);
      record = {
        schemaVersion: 5,
        name,
        projectId: projectRecord.id,
        projectName: projectRecord.name,
        rootRepositoryAlias: repo.alias,
        rootRef: selectedRoot.rootRef,
        rootCommit: selectedRoot.rootCommit,
        rootSnapshotPath: selectedRoot.rootSnapshotPath,
        repositoryRefOverrides,
        repositorySnapshot,
        projectPath: "/workspace/project",
        phase: "creating",
        profiles,
        capabilities,
        composeProjectName: `dim-${name}`,
        containerName: `dim-ws-${name}`,
        networkName: GITEA_NETWORK,
        dockerVolumeName: `dim-ws-${name}-docker`,
        runtimeBackend: input.runtimeBackend,
        kvm,
        cpuCount: input.cpuCount ?? options.cpuCount,
        memory: input.memory ?? options.memory,
        pidsLimit: input.pidsLimit ?? options.pidsLimit,
        routes: [],
        gitUserName,
        gitUserEmail,
        gitBaseUrl: `http://dim-gitea:3000/${projectRecord.gitNamespace}`,
        hostAliases: {},
        projectManifestPath: "/run/dim/project.json",
        createdAt: now,
        updatedAt: now
      };
      await state.claimWorkspace(record);
    }
    const release = await state.acquireWorkspaceSetupLock(name);
    try {
      const reconciled = await reconcileProject(runner, options, state, record, projectRecord, repo);
      return await setupWorkspaceLocked(runner, options, state, reconciled);
    } finally {
      await release();
    }
  } finally {
    await releaseProject();
  }
}
