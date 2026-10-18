import { randomBytes } from "node:crypto";
import path from "node:path";
import {
  ContainerWorkspaceRuntime, WorkspaceService, UserError, type CommandRunner, type CreateWorkspaceInput,
  type StreamingCommandRunner, type WorkspaceRecord, type WorkspaceStore, workspaceRuntimeResources
} from "@slop-lab/dim-core/workspace";
import { managedStateRoot } from "./lifecycleOptions.js";
import { loadNativeControlPlaneConnection } from "./nativeControlPlaneConnection.js";
import { NativeProjectPendingStore } from "./nativeProjectPendingStore.js";
import { proveNativeProjectReadiness } from "./nativeProjectReadinessClient.js";
import { createNativeGitRootReadIssuerClient } from "./nativeGitRootReadIssuerClient.js";
import { ensureNativeWorkspaceBroker } from "./nativeWorkspaceBrokerProcess.js";
import { nativeWorkspaceAttachmentFile, readNativeWorkspaceAttachment, writeNativeWorkspaceAttachment,
  type NativeWorkspaceAttachment } from "./nativeWorkspaceAttachment.js";

export interface ManagedWorkspaceHostContext {
  readonly store: WorkspaceStore;
  readonly runner: StreamingCommandRunner;
  readonly cleanupRunner?: CommandRunner;
  readonly signal?: AbortSignal;
}

/** Managed Git contributes acquisition and a scoped Git attachment; core owns the whole runtime lifecycle. */
export async function createManagedWorkspace(input: CreateWorkspaceInput, context: ManagedWorkspaceHostContext): Promise<WorkspaceRecord> {
  const match = /^dim:\/\/([a-z0-9][a-z0-9-]*)\/?$/.exec(input.source.url);
  if (!match) throw new UserError("managed source must be dim://PROJECT");
  const projectName = match[1]!;
  const connectionFile = process.env.DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE;
  if (!connectionFile || !path.isAbsolute(connectionFile)) throw new UserError("DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE must select a private host connection");
  const stateRoot = managedStateRoot(process.env);
  const connection = await loadNativeControlPlaneConnection(connectionFile);
  const project = await new NativeProjectPendingStore(stateRoot).read(projectName, connection.hostId);
  if (project?.phase !== "ready") throw new UserError(`native Project '${projectName}' is not ready`);
  if (input.source.ref !== undefined && input.source.ref !== project.protectedRef
    && input.source.ref !== project.protectedRef.slice("refs/heads/".length)) throw new UserError("managed workspaces start from the Project's protected ref");
  const signal = context.signal ?? AbortSignal.timeout(120_000);
  const proof = await proveNativeProjectReadiness(connection, project, signal, {
    commit: project.rootCommit, tree: project.rootTree, allowFastForward: true
  });
  const runtime = new ContainerWorkspaceRuntime(context.runner, context.cleanupRunner);
  const seed = runtime.seed.bind(runtime);
  runtime.seed = async (record, directory) => {
    await seed(record, directory);
    const network = workspaceRuntimeResources(record).network;
    const inspected = await context.runner.run("docker", ["network", "inspect", network, "--format", "{{json .IPAM.Config}}"]);
    if (inspected.exitCode !== 0) throw new UserError("cannot inspect owned workspace broker network");
    const configurations: unknown = JSON.parse(inspected.stdout);
    const gateway = Array.isArray(configurations) ? configurations.map((value) => value?.Gateway).find(privateAddress) : undefined;
    if (typeof gateway !== "string") throw new UserError("managed workspace Git requires a private IPv4 Docker network gateway");
    const attachment: NativeWorkspaceAttachment = { schemaVersion: 1, workspaceId: record.id, workspaceName: record.name,
      nativeWorkspaceId: randomBytes(32).toString("base64url"), projectName, projectId: project.projectId,
      protectedRef: proof.protectedRef, commit: proof.commit, tree: proof.tree,
      policyRevision: proof.policyRevision, requiredReviewRevision: proof.requiredReviewRevision,
      requiredJobSetRevision: proof.requiredJobSetRevision, connectionFile,
      workspaceStateRoot: context.store.root, managedStateRoot: stateRoot, gateway, port: 19419,
      grant: randomBytes(32).toString("base64url") };
    await writeNativeWorkspaceAttachment(attachment);
    await ensureNativeWorkspaceBroker(attachment, context.signal);
    const remote = `http://${gateway}:${attachment.port}/v1/projects/${attachment.projectId}/repositories/root.git`;
    const helper = `!f() { if [ "$1" = get ]; then printf 'username=dim\\npassword=${attachment.grant}\\n'; fi; }; f`;
    for (const command of [
      ["git", "remote", "set-url", "origin", remote],
      ["git", "config", "--local", "credential.helper", helper],
      ["git", "config", "--local", "credential.useHttpPath", "true"],
      ["git", "config", "--local", "remote.origin.push", `HEAD:refs/heads/proposals/${attachment.nativeWorkspaceId}/${proof.protectedRef.slice("refs/heads/".length)}`]
    ]) {
      const result = await runtime.run(record, command, { signal });
      if (result.exitCode !== 0) throw new UserError("cannot configure the scoped workspace Git origin");
    }
  };
  const service = new WorkspaceService(context.store, runtime, async ({ destination }) => {
    const lease = await createNativeGitRootReadIssuerClient({ schemaVersion: 1, endpoint: connection.nativeGit.endpoint,
      serviceId: "native-main", role: "operator-root-read-issuer", hostId: connection.hostId,
      generationId: proof.generationId, credential: connection.nativeGit.rootReadIssuer
    }).issueRootReadLease(project.projectId, signal);
    const environment: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
    Object.assign(environment, { GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader",
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`${lease.username}:${lease.password}`).toString("base64")}` });
    const git = async (args: string[]) => {
      const result = await context.runner.run("git", ["-c", "core.hooksPath=/dev/null", "-c", "init.templateDir=", ...args], { env: environment, signal });
      if (result.exitCode !== 0) throw new UserError("cannot acquire the attested native Project root");
      return result.stdout.trim();
    };
    const url = `${connection.nativeGit.endpoint}/v1/projects/${project.projectId}/repositories/root.git`;
    await git(["clone", "--no-checkout", "--single-branch", "--branch", proof.protectedRef.slice("refs/heads/".length), "--", url, destination]);
    await git(["-C", destination, "checkout", "--force", "-B", proof.protectedRef.slice("refs/heads/".length), proof.commit]);
    if (await git(["-C", destination, "rev-parse", "HEAD^{tree}"]) !== proof.tree) throw new UserError("native Project checkout differs from its attested tree");
    return { url: input.source.url, ref: proof.protectedRef, commit: proof.commit };
  });
  return service.create(input);
}

/** Called by host composition on use; ordinary workspace lifecycles never load this module. */
export async function ensureManagedWorkspace(record: WorkspaceRecord, context: ManagedWorkspaceHostContext): Promise<void> {
  const attachment = await readNativeWorkspaceAttachment(nativeWorkspaceAttachmentFile(managedStateRoot(process.env), record.id));
  if (attachment.workspaceName !== record.name || attachment.workspaceStateRoot !== context.store.root) throw new UserError("managed workspace attachment conflicts with the selected host");
  await ensureNativeWorkspaceBroker(attachment, context.signal);
}
function privateAddress(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d+\.\d+\.\d+\.\d+$/.test(value)) return false;
  const parts = value.split(".").map(Number);
  return parts.every((part) => part >= 0 && part <= 255)
    && (parts[0] === 10 || parts[0] === 192 && parts[1] === 168 || parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31);
}
