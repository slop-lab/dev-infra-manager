import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { atomicWrite, UserError } from "@slop-lab/dim-core";

export interface NativeWorkspaceAttachment {
  schemaVersion: 1;
  workspaceId: string;
  workspaceName: string;
  nativeWorkspaceId: string;
  projectName: string;
  projectId: string;
  protectedRef: string;
  commit: string;
  tree: string;
  policyRevision: string;
  requiredReviewRevision: string;
  requiredJobSetRevision: string;
  connectionFile: string;
  workspaceStateRoot: string;
  managedStateRoot: string;
  gateway: string;
  port: number;
  grant: string;
}

export function nativeWorkspaceAttachmentFile(root: string, workspaceId: string): string {
  if (!/^[0-9a-f-]{36}$/.test(workspaceId)) throw new UserError("invalid native workspace attachment identity");
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
      || metadata.nlink !== 1 || metadata.size > 64 * 1024) throw new UserError("native workspace attachment is not private host-owned state");
    const value: unknown = JSON.parse(await handle.readFile("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
    const record = value as Record<string, unknown>;
    const text = ["workspaceId", "workspaceName", "nativeWorkspaceId", "projectName", "projectId", "protectedRef", "commit", "tree",
      "policyRevision", "requiredReviewRevision", "requiredJobSetRevision", "connectionFile", "workspaceStateRoot", "managedStateRoot", "gateway", "grant"];
    if (record.schemaVersion !== 1 || Object.keys(record).length !== text.length + 2
      || text.some((key) => typeof record[key] !== "string" || (record[key] as string).length === 0 || (record[key] as string).includes("\0"))
      || typeof record.port !== "number" || !Number.isInteger(record.port) || record.port < 1 || record.port > 65535
      || !/^[A-Za-z0-9_-]{43}$/.test(record.nativeWorkspaceId as string) || !/^[A-Za-z0-9_-]{43}$/.test(record.grant as string)
      || ["connectionFile", "workspaceStateRoot", "managedStateRoot"].some((key) => !path.isAbsolute(record[key] as string))) throw invalid();
    const attachment = record as unknown as NativeWorkspaceAttachment;
    if (path.resolve(file) !== nativeWorkspaceAttachmentFile(attachment.managedStateRoot, attachment.workspaceId)) throw invalid();
    return attachment;
  } finally { await handle.close(); }
}
export function nativeWorkspaceBrokerHealth(attachment: NativeWorkspaceAttachment): string {
  return createHash("sha256").update(attachment.workspaceId).update(attachment.grant).digest("hex");
}
function invalid(): UserError { return new UserError("invalid native workspace attachment"); }
