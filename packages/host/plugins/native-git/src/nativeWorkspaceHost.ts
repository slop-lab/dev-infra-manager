import { refreshNativeWorkspaceConnection } from "./nativeWorkspaceConnection.js";
import { nativeRepositoryDefaultRef, nativeRepositoryBranchPolicy } from "@slop-lab/dim-contracts-git";
import { normalizeRepositoryRef } from "./repositoryRef.js";
import { selectedControlPlaneHostFile } from "./controlPlaneSelection.js";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { ContainerWorkspaceRuntime, WorkspaceService, UserError, type CommandRunner, type CreateWorkspaceInput,
  type StreamingCommandRunner, type WorkspaceRecord, type WorkspaceStore, type WorkspaceRuntime, type AcquiredWorkspaceSource } from "@slop-lab/dim-host-core/workspace";
import { managedStateRoot } from "@slop-lab/dim-host-core/controller";
import { loadNativeControlPlaneConnection } from "./nativeControlPlaneConnection.js";
import { NativeProjectPendingStore } from "./nativeProjectPendingStore.js";
import { proveNativeProjectReadiness, type NativeProjectReadinessProof } from "./nativeProjectReadinessClient.js";
import { createNativeGitRootReadIssuerClient } from "./nativeGitRootReadIssuerClient.js";
import { ensureNativeWorkspaceBroker } from "./nativeWorkspaceBrokerProcess.js";
import { nativeWorkspaceAttachmentFile, readNativeWorkspaceAttachment, writeNativeWorkspaceAttachment,
  type NativeWorkspaceAttachment, type NativeWorkspaceRepositoryAttachment, type NativeWorkspaceRepositoryProof } from "./nativeWorkspaceAttachment.js";

export interface ManagedWorkspaceHostContext {
  readonly store: WorkspaceStore;
  readonly runner: StreamingCommandRunner;
  readonly cleanupRunner?: CommandRunner;
  readonly signal?: AbortSignal;
  readonly runtime?: WorkspaceRuntime;
  readonly validateCheckout?: (directory: string, source: AcquiredWorkspaceSource) => Promise<void>;
}
/** Core owns lifecycle/storage; managed Git only acquires selected repositories and grants. */
export async function createManagedWorkspace(input: CreateWorkspaceInput & { readonly repositories?: readonly string[]; readonly workingDirectory?: string }, context: ManagedWorkspaceHostContext): Promise<WorkspaceRecord> {
  const match = /^dim:\/\/([a-z0-9][a-z0-9-]*)\/?$/.exec(input.source.url);
  if (!match) throw new UserError("managed source must be dim://PROJECT");
  const projectName = match[1]!, connectionFile = await selectedControlPlaneHostFile(), stateRoot = managedStateRoot(process.env);
  const connection = await loadNativeControlPlaneConnection(connectionFile);
  const project = await new NativeProjectPendingStore(stateRoot).read(projectName, connection.hostId);
  if (project?.phase !== "ready") throw new UserError(`native Project '${projectName}' has no configured repository defaults`);
  const selected = [...(input.repositories ?? [project.defaultWorkingRepositoryId])];
  if (!selected.length || selected.length > 64 || new Set(selected).size !== selected.length
    || selected.some((repositoryId) => !Object.hasOwn(project.repositories, repositoryId))) throw new UserError("workspace repositories must be a nonempty distinct subset of this Project's ready repositories");
  const workingDirectory = input.workingDirectory ?? (selected.includes(project.defaultWorkingRepositoryId) ? project.defaultWorkingRepositoryId : selected[0]!);
  if (!selected.includes(workingDirectory)) throw new UserError("working directory must name a selected repository");
  const working = project.repositories[workingDirectory]!;
  const workingRef = input.source.ref === undefined ? nativeRepositoryDefaultRef(working.repositoryPolicy) : normalizeRepositoryRef(input.source.ref);
  try { nativeRepositoryBranchPolicy(working.repositoryPolicy, workingRef); }
  catch (cause) { throw new UserError("managed workspaces must select a configured repository branch", { cause }); }
  const signal = context.signal ?? AbortSignal.timeout(120_000);
  const proofs = new Map<string, NativeProjectReadinessProof>();
  for (const repositoryId of selected) {
    const repository = project.repositories[repositoryId]!;
    proofs.set(repositoryId, await proveNativeProjectReadiness(connection, project, repositoryId, signal,
      { commit: repository.commit, tree: repository.tree, allowFastForward: true,
        protectedRef: repositoryId === workingDirectory ? workingRef : nativeRepositoryDefaultRef(repository.repositoryPolicy) }));
  }
  const configurationRepository = project.repositories[project.configurationRepositoryId]!;
  const configurationRef = nativeRepositoryDefaultRef(configurationRepository.repositoryPolicy);
  const selectedConfigurationProof = proofs.get(project.configurationRepositoryId);
  const configurationProof = selectedConfigurationProof?.protectedRef === configurationRef ? selectedConfigurationProof
    : await proveNativeProjectReadiness(connection, project, project.configurationRepositoryId, signal,
      { commit: configurationRepository.commit, tree: configurationRepository.tree, protectedRef: configurationRef, allowFastForward: true });
  const baseRuntime = context.runtime ?? new ContainerWorkspaceRuntime(context.runner, context.cleanupRunner);
  const hostGateway = baseRuntime.hostGateway?.bind(baseRuntime);
  const runtime: WorkspaceRuntime = {
    inspect: (record) => baseRuntime.inspect(record), create: (record) => baseRuntime.create(record),
    start: (record) => baseRuntime.start(record), stop: (record) => baseRuntime.stop(record),
    remove: (record, options) => baseRuntime.remove(record, options),
    updateResources: (record, resources) => baseRuntime.updateResources(record, resources),
    exec: (record, command, options) => baseRuntime.exec(record, command, options),
    connect: (record, port, options) => baseRuntime.connect(record, port, options),
    ...(hostGateway ? { hostGateway } : {}),
    seed: async (record, directory) => {
    await baseRuntime.seed(record, directory);
    const gateway = await runtime.hostGateway?.(record);
    if (!privateAddress(gateway)) throw new UserError("managed workspace Git requires a private IPv4 host service gateway");
    const repositories: Record<string, NativeWorkspaceRepositoryAttachment> = {};
    for (const repositoryId of selected) repositories[repositoryId] = { ...binding(proofs.get(repositoryId)!),
      nativeWorkspaceId: randomBytes(32).toString("base64url"), grant: randomBytes(32).toString("base64url") };
    const attachment: NativeWorkspaceAttachment = { schemaVersion: 2, workspaceId: record.id, workspaceName: record.name,
      projectName, projectId: project.projectId, configuration: binding(configurationProof), repositories,
      connectionFile, workspaceStateRoot: context.store.root, managedStateRoot: stateRoot, gateway, port: 19419 };
    await writeNativeWorkspaceAttachment(attachment);
    await ensureNativeWorkspaceBroker(attachment, context.signal);
    for (const [repositoryId, repository] of Object.entries(repositories)) {
      const remote = `http://${gateway}:${attachment.port}/v1/projects/${project.projectId}/repositories/${repositoryId}.git`;
      const helper = `!f() { if [ "$1" = get ]; then printf 'username=dim\\npassword=${repository.grant}\\n'; fi; }; f`;
      const syncFetch = Object.hasOwn(project.repositories[repositoryId]!.repositoryPolicy.extensions, "git-sync")
        ? [["config", "--local", "--add", "remote.origin.fetch", "+refs/remotes/upstream/*:refs/remotes/upstream/*"]] : [];
      for (const args of [["remote", "set-url", "origin", remote], ["config", "--local", "credential.helper", helper],
        ["config", "--local", "credential.useHttpPath", "true"], ["config", "--local", "remote.origin.push",
          `HEAD:refs/heads/proposals/${repository.nativeWorkspaceId}/${repository.protectedRef.slice("refs/heads/".length)}`], ...syncFetch]) {
        if (await runtime.exec(record, ["git", "-C", `/workspace/${repositoryId}`, ...args], { signal }) !== 0) throw new UserError(`cannot configure scoped Git origin for '${repositoryId}'`);
      }
    }
    }
  };
  const service = new WorkspaceService(context.store, runtime, async ({ destination }) => {
    await mkdir(destination, { mode: 0o700 });
    const temporary = await mkdtemp(path.join(path.dirname(destination), "configuration-"));
    try {
      const sharesConfigurationCheckout = selected.includes(project.configurationRepositoryId)
        && proofs.get(project.configurationRepositoryId)?.protectedRef === configurationProof.protectedRef;
      const configurationDirectory = sharesConfigurationCheckout
        ? path.join(destination, project.configurationRepositoryId) : path.join(temporary, "checkout");
      const clone = async (repositoryId: string, directory: string, proof: NativeProjectReadinessProof) => {
        const lease = await createNativeGitRootReadIssuerClient({ schemaVersion: 1, endpoint: connection.nativeGit.endpoint,
          serviceId: "native-main", role: "operator-root-read-issuer", hostId: connection.hostId,
          generationId: proof.generationId, credential: connection.nativeGit.rootReadIssuer }).issueRepositoryReadLease(project.projectId, repositoryId, signal);
        const environment: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
        Object.assign(environment, { GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`${lease.username}:${lease.password}`).toString("base64")}` });
        const git = async (args: string[]) => {
          const result = await context.runner.run("git", ["-c", "core.hooksPath=/dev/null", "-c", "init.templateDir=", ...args], { env: environment, signal });
          if (result.exitCode !== 0) throw new UserError(`cannot acquire attested repository '${repositoryId}'`);
          return result.stdout.trim();
        };
        await git(["clone", "--no-checkout", "--single-branch", "--branch", proof.protectedRef.slice("refs/heads/".length), "--",
          `${connection.nativeGit.endpoint}/v1/projects/${project.projectId}/repositories/${repositoryId}.git`, directory]);
        await git(["-C", directory, "checkout", "--force", "-B", proof.protectedRef.slice("refs/heads/".length), proof.commit]);
        if (await git(["-C", directory, "rev-parse", "HEAD^{tree}"]) !== proof.tree) throw new UserError(`repository '${repositoryId}' differs from its attested tree`);
        return { url: `dim://${projectName}/${repositoryId}`, ref: proof.protectedRef, commit: proof.commit };
      };
      const configurationSource = await clone(project.configurationRepositoryId, configurationDirectory, configurationProof);
      await context.validateCheckout?.(configurationDirectory, configurationSource);
      const checkouts = [];
      for (const repositoryId of selected) checkouts.push({ directory: repositoryId,
        source: repositoryId === project.configurationRepositoryId && sharesConfigurationCheckout ? configurationSource : await clone(repositoryId, path.join(destination, repositoryId), proofs.get(repositoryId)!) });
      return { ...configurationSource, checkouts, workingDirectory };
    } finally { await rm(temporary, { recursive: true, force: true }); }
  });
  return service.create(input);
}
export async function ensureManagedWorkspace(record: WorkspaceRecord, context: ManagedWorkspaceHostContext): Promise<void> {
  const attachment = await readNativeWorkspaceAttachment(nativeWorkspaceAttachmentFile(managedStateRoot(process.env), record.id));
  if (attachment.workspaceName !== record.name || attachment.workspaceStateRoot !== context.store.root) throw new UserError("managed workspace attachment conflicts with the selected host");
  await ensureNativeWorkspaceBroker(await refreshNativeWorkspaceConnection(attachment, context.signal ?? AbortSignal.timeout(10_000)), context.signal);
}
function binding(proof: NativeProjectReadinessProof): NativeWorkspaceRepositoryProof {
  return { repositoryId: proof.repositoryId, protectedRef: proof.protectedRef, commit: proof.commit, tree: proof.tree,
    policyRevision: proof.policyRevision };
}
function privateAddress(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d+\.\d+\.\d+\.\d+$/.test(value)) return false;
  const parts = value.split(".").map(Number);
  return parts.every((part) => part >= 0 && part <= 255) && (parts[0] === 10 || parts[0] === 192 && parts[1] === 168 || parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31);
}

export { nativeWorkspaceMetadata } from "./nativeWorkspaceMetadata.js";
