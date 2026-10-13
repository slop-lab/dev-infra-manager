import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { MissingRecordError, UserError } from "./errors.js";
import { LifecycleState, validateLifecycleName } from "./lifecycleState.js";
import { loadNativeControlPlaneConnection } from "./nativeControlPlaneConnection.js";
import { NativeProjectPendingStore } from "./nativeProjectPendingStore.js";
import { proveNativeProjectReadiness } from "./nativeProjectReadinessClient.js";
import { materializeNativeProjectReadinessRoot } from "./nativeProjectRootSelection.js";
import type { LifecycleOptions, WorkspaceRecord } from "./lifecycleTypes.js";
import type { RegisteredDimPlugins } from "./plugin.js";
import type { StreamingCommandRunner } from "./types.js";
import { setupWorkspaceLocked, reconcileNativeWorkspace } from "./workspaceSetup.js";
import { assertWorkspaceLifecycleActive } from "./workspaceRecord.js";
import { readWorkspaceForOperation, resolveWorkspaceCapabilities, resolveWorkspaceKvm,
  validateWorkspaceProfiles, validateWorkspaceResources } from "./workspaceValidation.js";
import { selectWorkspaceEnvironment } from "./workspaceEnvironment.js";
import { allocateWorkspaceResourceBudget } from "./workspaceResourceBudget.js";

type NativeWorkspaceCreateRequest = {
  readonly project: string;
  readonly name: string;
  readonly profiles: string[];
  readonly requiredCapabilities?: string[];
  readonly recommendedCapabilities?: string[];
  readonly runtimeBackend: WorkspaceRecord["runtimeBackend"];
  readonly cpuCount?: string;
  readonly memory?: string;
  readonly pidsLimit?: string;
  readonly kvm?: boolean;
  readonly gitUserName?: string;
  readonly gitUserEmail?: string;
};

export type NativeWorkspaceCreationInput = {
  readonly runner: StreamingCommandRunner;
  readonly options: LifecycleOptions;
  readonly request: NativeWorkspaceCreateRequest;
  readonly plugins: Pick<RegisteredDimPlugins, "workspaceCapabilityProviders">;
};

export async function createNativeWorkspace(input: NativeWorkspaceCreationInput): Promise<WorkspaceRecord> {
  const selected = input.options.nativeControlPlaneConnection;
  if (selected === undefined) throw new UserError("native control-plane selection is required");
  const projectName = validateLifecycleName(input.request.project, "project");
  const name = validateLifecycleName(input.request.name, "workspace");
  const profiles = validateWorkspaceProfiles(input.request.profiles);
  const resources = { cpuCount: input.request.cpuCount ?? input.options.cpuCount,
    memory: input.request.memory ?? input.options.memory,
    pidsLimit: input.request.pidsLimit ?? input.options.pidsLimit };
  validateWorkspaceResources(resources);
  const projects = new NativeProjectPendingStore(input.options.stateRoot);
  const state = new LifecycleState(input.options.stateRoot);
  const releaseProject = await state.acquireProjectLock(projectName);
  try {
    const connection = await loadNativeControlPlaneConnection(selected.file);
    const project = await projects.read(projectName, connection.hostId);
    if (project?.phase !== "ready") throw new UserError(`native project '${projectName}' is not ready`);
    const signal = AbortSignal.timeout(10_000);
    const proof = await proveNativeProjectReadiness(connection, project, signal, {
      commit: project.rootCommit, tree: project.rootTree, allowFastForward: true
    });
    await materializeNativeProjectReadinessRoot({
      stateRoot: input.options.stateRoot, connection, project, proof, signal
    });
    const releaseSetup = await state.acquireWorkspaceSetupLock(name);
    try {
      let existing: WorkspaceRecord | undefined;
      try {
        existing = await readWorkspaceForOperation(state, name, input.options.giteaConnection);
        assertWorkspaceLifecycleActive(existing);
      } catch (error) {
        if (!(error instanceof MissingRecordError)) throw error;
      }
      const environment = existing === undefined
        ? await selectWorkspaceEnvironment(join(
          input.options.stateRoot, "assets", "native-project-roots", project.projectId, proof.commit
        ))
        : existing.environment ?? "custom";
      allocateWorkspaceResourceBudget(environment, resources);
      const workspaceId = existing?.workspaceId ?? randomBytes(32).toString("base64url");
      const capabilities = await resolveWorkspaceCapabilities({
        required: input.request.requiredCapabilities ?? [],
        recommended: input.request.recommendedCapabilities ?? []
      }, { workspaceId, projectId: project.projectId, projectName, workspaceName: name,
        runtimeBackend: input.request.runtimeBackend }, input.plugins.workspaceCapabilityProviders);
      let record: WorkspaceRecord;
      if (existing !== undefined) {
        if (existing.schemaVersion !== 9 || existing.projectId !== project.projectId) {
          throw new UserError(`workspace '${name}' is already bound to another Project source`);
        }
        record = existing;
      } else {
        const now = new Date().toISOString();
        record = {
          schemaVersion: 9, workspaceId, name, projectId: project.projectId, projectName,
          rootRepositoryAlias: project.rootAlias, rootRef: proof.protectedRef,
          rootCommit: proof.commit, workspaceDataPath: "/var/lib/dim/workspace-data", environment,
          phase: "creating", profiles, capabilities, composeProjectName: `dim-${name}`,
          containerName: `dim-ws-${name}`, networkName: "bridge",
          dockerVolumeName: `dim-ws-${name}-docker`, runtimeBackend: input.request.runtimeBackend,
          kvm: await resolveWorkspaceKvm(input.request.runtimeBackend, input.request.kvm),
          ...resources, routes: [], gitUserName: input.request.gitUserName ?? `dim/${name}`,
          gitUserEmail: input.request.gitUserEmail ?? `${name}@dim.invalid`, hostAliases: {},
          projectManifestPath: "/run/dim/project.json", createdAt: now, updatedAt: now,
          source: {
            kind: "native", serviceId: project.serviceId,
            snapshot: { projectId: project.projectId, repositoryId: "root",
              protectedRef: proof.protectedRef, commit: proof.commit, tree: proof.tree },
            policyRevision: project.reviewPolicy.policyRevision,
            requiredReviewRevision: project.reviewPolicy.requiredReviewRevision,
            requiredJobSetRevision: project.reviewPolicy.requiredJobSetRevision
          }
        };
        await state.claimWorkspace(record);
      }
      const reconciled = await reconcileNativeWorkspace(input.runner, input.options, state, record, () => undefined);
      return setupWorkspaceLocked(input.runner, input.options, state, reconciled);
    } finally {
      await releaseSetup();
    }
  } finally {
    await releaseProject();
  }
}
