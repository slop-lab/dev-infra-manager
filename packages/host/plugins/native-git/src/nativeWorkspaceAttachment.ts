import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { atomicWrite, UserError } from "@slop-lab/dim-host-core";

export interface NativeWorkspaceRepositoryProof {
  repositoryId: string;
  protectedRef: string;
  commit: string;
  tree: string;
  policyRevision: string;
}
export interface NativeWorkspaceRepositoryAttachment extends NativeWorkspaceRepositoryProof { nativeWorkspaceId: string; grant: string }
export interface NativeWorkspaceAttachment {
  schemaVersion: 2;
  workspaceId: string;
  workspaceName: string;
  projectName: string;
  projectId: string;
  configuration: NativeWorkspaceRepositoryProof;
  repositories: Record<string, NativeWorkspaceRepositoryAttachment>;
  connectionFile: string;
  workspaceStateRoot: string;
  managedStateRoot: string;
  gateway: string;
  port: number;
}
export function nativeWorkspaceAttachmentFile(root: string, workspaceId: string): string {
  if (!/^[0-9a-f-]{36}$/.test(workspaceId)) throw invalid();
  return path.join(root, "native-workspace-attachments", `${workspaceId}.json`);
}
export async function writeNativeWorkspaceAttachment(attachment: NativeWorkspaceAttachment): Promise<void> {
  await atomicWrite(nativeWorkspaceAttachmentFile(attachment.managedStateRoot, attachment.workspaceId), attachment);
}
export async function readNativeWorkspaceAttachment(file: string): Promise<NativeWorkspaceAttachment> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.uid !== process.geteuid?.() || (metadata.mode & 0o777) !== 0o600
      || metadata.nlink !== 1 || metadata.size > 128 * 1024) throw new UserError("native workspace attachment is not private host-owned state");
    const value = object(JSON.parse(await handle.readFile("utf8")));
    exact(value, ["schemaVersion", "workspaceId", "workspaceName", "projectName", "projectId", "configuration", "repositories", "connectionFile", "workspaceStateRoot", "managedStateRoot", "gateway", "port"]);
    if (value.schemaVersion !== 2 || typeof value.port !== "number" || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535) throw invalid();
    const repositories: Record<string, NativeWorkspaceRepositoryAttachment> = {};
    const entries = Object.entries(object(value.repositories));
    if (!entries.length || entries.length > 64) throw invalid();
    for (const [id, input] of entries) {
      const entry = object(input);
      const proof = repositoryProof(entry, ["nativeWorkspaceId", "grant"]);
      if (id !== proof.repositoryId) throw invalid();
      repositories[id] = { ...proof, nativeWorkspaceId: token(entry.nativeWorkspaceId), grant: token(entry.grant) };
    }
    const attachment: NativeWorkspaceAttachment = { schemaVersion: 2, workspaceId: text(value.workspaceId), workspaceName: text(value.workspaceName),
      projectName: text(value.projectName), projectId: text(value.projectId), configuration: repositoryProof(object(value.configuration)), repositories,
      connectionFile: text(value.connectionFile), workspaceStateRoot: text(value.workspaceStateRoot), managedStateRoot: text(value.managedStateRoot), gateway: text(value.gateway), port: value.port };
    if ([attachment.connectionFile, attachment.workspaceStateRoot, attachment.managedStateRoot].some((entry) => !path.isAbsolute(entry))
      || path.resolve(file) !== nativeWorkspaceAttachmentFile(attachment.managedStateRoot, attachment.workspaceId)) throw invalid();
    return attachment;
  } finally { await handle.close(); }
}
function repositoryProof(value: Record<string, unknown>, extras: readonly string[] = []): NativeWorkspaceRepositoryProof {
  exact(value, ["repositoryId", "protectedRef", "commit", "tree", "policyRevision", ...extras]);
  const repositoryId = text(value.repositoryId), commit = text(value.commit), tree = text(value.tree);
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(repositoryId) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit) || tree.length !== commit.length || !/^[a-f0-9]+$/.test(tree)) throw invalid();
  for (const field of ["policyRevision"]) if (!/^[a-f0-9]{64}$/.test(text(value[field]))) throw invalid();
  return { repositoryId, protectedRef: text(value.protectedRef), commit, tree, policyRevision: text(value.policyRevision) };
}
export function nativeWorkspaceBrokerCredential(attachment: NativeWorkspaceAttachment): string {
  const first = Object.values(attachment.repositories)[0];
  if (!first) throw invalid();
  return first.grant;
}
export function nativeWorkspaceBrokerHealth(attachment: NativeWorkspaceAttachment): string {
  const repositories = Object.fromEntries(Object.entries(attachment.repositories).map(([id, binding]) => {
    const { policyRevision: _revision, ...scope } = binding;
    return [id, scope];
  }));
  return createHash("sha256").update(attachment.workspaceId).update(JSON.stringify(repositories)).digest("hex");
}
function token(value: unknown): string { const result = text(value); if (!/^[A-Za-z0-9_-]{43}$/.test(result)) throw invalid(); return result; }
function text(value: unknown): string { if (typeof value !== "string" || !value || value.includes("\0")) throw invalid(); return value; }
function object(value: unknown): Record<string, unknown> { if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid(); return value as Record<string, unknown>; }
function exact(value: Record<string, unknown>, fields: readonly string[]): void { if (Object.keys(value).length !== fields.length || fields.some((field) => !Object.hasOwn(value, field))) throw invalid(); }
function invalid(): UserError { return new UserError("invalid native workspace attachment"); }
