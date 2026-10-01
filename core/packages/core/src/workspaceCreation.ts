import { MissingRecordError, UserError } from "./errors.js";
import { ensureGitea, giteaNestedBaseUrl, GITEA_NETWORK } from "./gitea.js";
import { LifecycleState, validateLifecycleName } from "./lifecycleState.js";
import type { LifecycleOptions, WorkspaceRecord } from "./lifecycleTypes.js";
import type { RegisteredDimPlugins } from "./plugin.js";
import { assertProjectRepositoriesReady } from "./protectedRootResolution.js";
import { resolveProtectedRootSnapshot } from "./protectedRootSnapshot.js";
import type { StreamingCommandRunner } from "./types.js";
import { runWorkspaceLifecycle, runWorkspaceLifecycleStage } from "./workspaceLifecycleError.js";
import { reconcileProject, setupWorkspaceLocked } from "./workspaceSetup.js";
import { assertSelectedProjectUnchanged } from "./workspaceState.js";
import {
  resolveWorkspaceCapabilities,
  resolveWorkspaceKvm,
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
  return runWorkspaceLifecycle("create", async (setStage) => {
    const project = validateLifecycleName(input.project, "project");
    const name = validateLifecycleName(input.name, "workspace");
    const profiles = validateWorkspaceProfiles(input.profiles);
    validateWorkspaceResources({
      cpuCount: input.cpuCount ?? options.cpuCount,
      memory: input.memory ?? options.memory,
      pidsLimit: input.pidsLimit ?? options.pidsLimit
    });
    const state = new LifecycleState(options.stateRoot);
    setStage("project readiness validation");
    assertProjectRepositoriesReady(await state.readProject(project));
    setStage("managed Git reconciliation");
    const externalCredentials = options.giteaConnection.kind === "external"
      ? await ensureGitea(runner, options)
      : undefined;
    setStage("protected root selection");
    const selectedRoot = await resolveProtectedRootSnapshot({ runner, options, projectName: project });
    setStage("Project lock acquisition");
    const releaseProject = await state.acquireProjectLock(project);
    try {
      setStage("protected root validation");
      await assertSelectedProjectUnchanged(state, selectedRoot);
      const projectRecord = selectedRoot.project;
      setStage("workspace capability resolution");
      const capabilities = await resolveWorkspaceCapabilities(
        input.requiredCapabilities ?? [], input.recommendedCapabilities ?? [], projectRecord, name,
        input.runtimeBackend, plugins.workspaceCapabilityProviders
      );
      const repo = selectedRoot.repository;
      const now = new Date().toISOString();
      const gitUserName = input.gitUserName ?? process.env.DIM_GIT_USER_NAME ?? `dim/${name}`;
      const gitUserEmail = input.gitUserEmail ?? process.env.DIM_GIT_USER_EMAIL ?? `${name}@dim.invalid`;
      let record: WorkspaceRecord;
      try {
        setStage("workspace state loading");
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
        setStage("runtime capability resolution");
        const kvm = await resolveWorkspaceKvm(input.runtimeBackend, input.kvm);
        setStage("managed Git address discovery");
        const credentials = externalCredentials ?? await ensureGitea(runner, options);
        const gitBaseUrl = `${await giteaNestedBaseUrl(runner, credentials)}/${projectRecord.gitNamespace}`;
        record = {
          schemaVersion: 7,
          name,
          projectId: projectRecord.id,
          projectName: projectRecord.name,
          rootRepositoryAlias: repo.alias,
          rootRef: selectedRoot.rootRef,
          rootCommit: selectedRoot.rootCommit,
          workspaceDataPath: "/var/lib/dim/workspace-data",
          phase: "creating",
          profiles,
          capabilities,
          composeProjectName: `dim-${name}`,
          containerName: `dim-ws-${name}`,
          networkName: credentials.kind === "managed" ? GITEA_NETWORK : "bridge",
          dockerVolumeName: `dim-ws-${name}-docker`,
          runtimeBackend: input.runtimeBackend,
          kvm,
          cpuCount: input.cpuCount ?? options.cpuCount,
          memory: input.memory ?? options.memory,
          pidsLimit: input.pidsLimit ?? options.pidsLimit,
          routes: [],
          gitUserName,
          gitUserEmail,
          gitBaseUrl,
          hostAliases: {},
          projectManifestPath: "/run/dim/project.json",
          createdAt: now,
          updatedAt: now
        };
        setStage("workspace state claim");
        await state.claimWorkspace(record);
      }
      setStage("workspace setup lock acquisition");
      const release = await state.acquireWorkspaceSetupLock(name);
      try {
        setStage("workspace reconciliation");
        const reconciled = await reconcileProject(runner, options, state, record, projectRecord, repo, setStage);
        return await setupWorkspaceLocked(runner, options, state, reconciled, false, false, setStage);
      } finally {
        await runWorkspaceLifecycleStage("create", "workspace setup lock release", release);
      }
    } finally {
      await runWorkspaceLifecycleStage("create", "Project lock release", releaseProject);
    }
  });
}
