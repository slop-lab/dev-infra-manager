import { z } from "zod";

const identifier = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/);

export {
  classifyNativeGitCandidateRef,
  isNativeGitCandidateRef,
  isNativeGitLegacyProposalRef,
  isNativeGitLegacyWorkspaceProposalRef,
  isNativeGitOrdinaryCandidateRef,
  nativeGitCandidateWorkspaceId,
  type NativeGitCandidateRef
} from "./candidate-ref.js";

export {
  nativeImportedRootPolicySchema,
  nativeRepositoryBranchPolicy,
  nativeRepositoryBranchPolicySchema,
  nativeRepositoryBranches,
  nativeRepositoryDefaultRef,
  nativeRepositoryPolicyRevision,
  parseAuthoritativeImportedRootPolicy,
  type NativeImportedRootPolicy,
  type NativeRepositoryBranchPolicy
} from "./policy.js";

const gitObjectId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
export const repositorySnapshotsSchema = z.record(identifier, z.object({ commit: gitObjectId, tree: gitObjectId }).strict().readonly()).refine((entries) => Object.keys(entries).length > 0 && Object.keys(entries).length <= 64).readonly();
export type RepositorySnapshots = z.infer<typeof repositorySnapshotsSchema>;
export type RepositorySelector = { readonly projectId: string; readonly repositoryId: string };

export {
  nativeGitProjectAttachmentMaximumBytes,
  nativeGitProjectAttachmentMaximumRepositories,
  nativeGitProjectAttachmentSchema,
  nativeGitProjectCatalogMaximumProjects,
  nativeGitProjectCatalogSchema,
  nativeGitRootImportReceiptSchema,
  NativeGitProjectAttachmentContractError,
  parseNativeGitProjectAttachment,
  parseNativeGitProjectCatalog,
  type NativeGitProjectAttachment,
  type NativeGitProjectCatalog,
  type NativeGitRootImportReceipt
} from "./project-attachment.js";
