import { z } from "zod";

const identifier = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/);
const gitObjectId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);

export interface Namespace {
  readonly namespaceId: string;
}

export interface RepositorySelector extends Namespace {
  readonly repositoryId: string;
}

export const repositorySnapshotsSchema = z.record(
  identifier,
  z.object({ commit: gitObjectId, tree: gitObjectId }).strict().readonly()
).refine((entries) => Object.keys(entries).length > 0 && Object.keys(entries).length <= 64).readonly();

export type RepositorySnapshots = z.infer<typeof repositorySnapshotsSchema>;
