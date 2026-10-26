import { UserError } from "@slop-lab/dim-host-core";

export function repositoryReviewDefaultsNeeded(extensions: unknown, branches?: Readonly<Record<string, { readonly review: boolean }>>): boolean {
  if (extensions !== undefined && (typeof extensions !== "object" || extensions === null || Array.isArray(extensions))) return false;
  return !Object.hasOwn(extensions ?? {}, "code-review") && (branches === undefined || Object.values(branches).some(({ review }) => review));
}

/** Called only by trusted operator import paths, using their connected reviewer identity. */
export function defaultRepositoryReviewExtensions(extensions: unknown, reviewerId?: string, branches?: Readonly<Record<string, { readonly review: boolean }>>): unknown {
  if (!repositoryReviewDefaultsNeeded(extensions, branches)) return extensions ?? {};
  if (reviewerId === undefined || !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(reviewerId)) throw new UserError("Repository import requires a configured reviewer identity");
  return {
    "code-review": { requiredReviewerIds: [], pathReviewerRules: [{ pathPrefix: ".dim/", reviewerIds: [reviewerId] }] },
    "merge-policy": {},
    ...extensions as Readonly<Record<string, unknown>> | undefined
  };
}
