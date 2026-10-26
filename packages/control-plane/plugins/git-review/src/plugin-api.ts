import type { ReviewChangeMatcher } from "./change-matchers.js";
import type { ControlPlaneExtension } from "@slop-lab/dim-control-plane-core/plugin-api";
import type { RepositoryRuntime, RepositoryExtensionContext, AuthoritativeNativeRepositoryTarget } from "@slop-lab/dim-control-plane-plugin-git-repositories/plugin-api";
import type { AuthoritativeNativeReviewIdentity, AuthoritativeNativeReviewEnvelope } from "./authoritative-native-review-schema.js";
import type { inspectAuthoritativeNativeReviewGit } from "./authoritative-native-review-git.js";

export const reviewPreparationKind = "dim.code-review.preparation";
export type ReviewAttachment = { readonly kind: string; readonly id: string; readonly digest: string };
export type RepositorySnapshots = Readonly<Record<string, { readonly commit: string; readonly tree: string }>>;
export type ReviewPreparationInput = {
  readonly runtime: RepositoryRuntime;
  readonly selector: { readonly projectId: string; readonly repositoryId: string; readonly proposalRef: string; readonly protectedRef?: string | undefined };
  readonly target: AuthoritativeNativeRepositoryTarget;
  readonly evidence: Awaited<ReturnType<typeof inspectAuthoritativeNativeReviewGit>>;
  readonly identity: Omit<AuthoritativeNativeReviewIdentity, "inputs">;
};
export type ReviewPreparation = {
  readonly name: string;
  prepare(input: ReviewPreparationInput): Promise<{ readonly inputs: RepositorySnapshots; readonly attachment?: ReviewAttachment }>;
  assertCurrent?(input: { readonly runtime: RepositoryRuntime; readonly review: AuthoritativeNativeReviewIdentity; readonly attachment?: ReviewAttachment }): Promise<void>;
  accepted?(input: { readonly runtime: RepositoryRuntime; readonly envelope: AuthoritativeNativeReviewEnvelope; readonly ownerRequestId: string }): Promise<void>;
};
export type CodeReviewRuntime = RepositoryRuntime & { readonly reviewPreparations?: readonly ReviewPreparation[]; readonly reviewChangeMatchers?: readonly ReviewChangeMatcher[] };
export function reviewPreparationExtension(preparation: ReviewPreparation): ControlPlaneExtension {
  return { kind: reviewPreparationKind, name: preparation.name, value: preparation };
}
export function reviewPreparations(extensions: readonly ControlPlaneExtension[]): readonly ReviewPreparation[] {
  return extensions.filter((entry) => entry.kind === reviewPreparationKind).map((entry) => {
    if (!("prepare" in entry.value) || typeof entry.value.prepare !== "function") throw new Error(`invalid review preparation: ${entry.name}`);
    return entry.value as ReviewPreparation;
  });
}
export type CodeReviewService = {
  readonly name: "code-review";
  /** Trusted caller already holds the repository mutation queue. */
  createInTransaction(context: RepositoryExtensionContext, input: { readonly projectId: string; readonly repositoryId: string; readonly proposalRef: string; readonly protectedRef?: string | undefined; readonly ownerRequestId?: string }): Promise<AuthoritativeNativeReviewEnvelope>;
  create(context: RepositoryExtensionContext, input: { readonly projectId: string; readonly repositoryId: string; readonly proposalRef: string; readonly protectedRef?: string | undefined; readonly ownerRequestId?: string }): Promise<AuthoritativeNativeReviewEnvelope>;
};
export async function acceptReviewPreparations(runtime: CodeReviewRuntime, envelope: AuthoritativeNativeReviewEnvelope, ownerRequestId: string): Promise<void> {
  for (const preparation of runtime.reviewPreparations ?? []) await preparation.accepted?.({ runtime, envelope, ownerRequestId });
}
export * from "./authoritative-native-review-schema.js";
export * from "./authoritative-native-review-store.js";
export * from "./authoritative-native-decision-store.js";
export * from "./native-human-reviewer-freshness.js";
export * from "./authoritative-native-review.js";
export * from "./review-record-storage.js";
export { AuthoritativeNativeReviewAdmissionBusyError } from "./authoritative-native-review-controller.js";

export * from "./change-matchers.js";

export function codeReviewService(extensions: readonly ControlPlaneExtension[]): CodeReviewService {
  const entry = extensions.find((entry) => entry.kind === "dim.code-review.service" && entry.name === "default");
  if (entry === undefined || !("createInTransaction" in entry.value) || typeof entry.value.createInTransaction !== "function" || !("create" in entry.value) || typeof entry.value.create !== "function") throw new Error("Git review service is required");
  return entry.value as CodeReviewService;
}

export { readAuthoritativeNativeReviewRefs, assertAuthoritativeNativeReviewRefs } from "./authoritative-native-review-git.js";
