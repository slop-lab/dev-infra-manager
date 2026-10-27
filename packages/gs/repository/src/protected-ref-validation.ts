import { join } from "node:path";
import { z } from "zod";
import { assertRepositorySelector, GitRepositoryError, type GitRepositoryRuntime, type RepositorySelector } from "./repository.js";

const identifier = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/);
const objectId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const gitRef = z.string().refine(isGitRef, "Git ref is invalid");
const protectedRef = gitRef.refine((value) => value.startsWith("refs/heads/"), "protected ref must name a branch");
const selectorShape = { namespaceId: identifier, repositoryId: identifier } as const;
const selectorSchema = z.object(selectorShape).strict().readonly();
const protectedRefChangeSchema = z.object({
  ...selectorShape,
  protectedRef: protectedRef.optional(),
  proposalRef: gitRef,
  expectedCommit: objectId,
  candidateCommit: objectId,
  candidateTree: objectId,
  authorizationId: digest,
  evidenceDigest: digest,
}).strict().readonly();
const protectedRefHeadSchema = z.object({
  sequence: z.number().int().nonnegative(),
  protectedRef,
  commit: objectId,
  tree: objectId,
}).strict().readonly();
const protectedRefTargetSchema = z.object({
  selector: selectorSchema,
  repositoryPath: z.string().min(1),
  head: protectedRefHeadSchema,
});
const protectedRefIntentCoreSchema = z.object({
  ...selectorShape,
  sequence: z.number().int().positive(),
  protectedRef,
  proposalRef: gitRef,
  expectedCommit: objectId,
  expectedTree: objectId,
  candidateCommit: objectId,
  candidateTree: objectId,
  authorizationId: digest,
  evidenceDigest: digest,
});

export type ProtectedRefChange = z.infer<typeof protectedRefChangeSchema>;

export function parseProtectedRefChange(input: ProtectedRefChange): ProtectedRefChange {
  const change = protectedRefChangeSchema.parse(input);
  assertRepositorySelector(change);
  return change;
}

export function assertProtectedRefIntent(intent: RepositorySelector & object): void {
  protectedRefIntentCoreSchema.parse(intent);
  assertRepositorySelector(intent);
}

export function assertTargetBinding(
  runtime: Pick<GitRepositoryRuntime, "storageRoot">,
  change: ProtectedRefChange,
  target: {
    readonly selector: RepositorySelector;
    readonly repositoryPath: string;
    readonly head: { readonly sequence: number; readonly protectedRef: string; readonly commit: string; readonly tree: string };
  },
): void {
  protectedRefTargetSchema.parse(target);
  assertRepositorySelector(target.selector);
  if (target.selector.namespaceId !== change.namespaceId
    || target.selector.repositoryId !== change.repositoryId
    || target.repositoryPath !== repositoryPath(runtime.storageRoot, change)
    || (change.protectedRef !== undefined && target.head.protectedRef !== change.protectedRef)) {
    throw new GitRepositoryError("protected ref target proof does not match the requested repository");
  }
}

export function assertRecoveryPath(
  runtime: Pick<GitRepositoryRuntime, "storageRoot">,
  intent: RepositorySelector,
  actualPath: string,
): void {
  if (actualPath !== repositoryPath(runtime.storageRoot, intent)) {
    throw new GitRepositoryError("pending repository ref target does not match its intent");
  }
}

function repositoryPath(storageRoot: string, selector: RepositorySelector): string {
  return join(storageRoot, selector.namespaceId, `${selector.repositoryId}.git`);
}

function isGitRef(value: string): boolean {
  if (!value.startsWith("refs/") || value.endsWith("/") || value.endsWith(".")
    || value.includes("..") || value.includes("@{") || value.includes("//")
    || /[\u0000-\u0020\u007f~^:?*\[\\]/.test(value)) return false;
  return value.split("/").every((part) => part.length > 0 && !part.startsWith(".") && !part.endsWith(".lock"));
}
