import type { ControlPlaneExtension } from "@slop-lab/dim-control-plane-core/plugin-api";
import type {
  AuthoritativeNativeRepositoryTarget,
  RepositoryExtensionContext,
  RepositoryRuntime,
} from "@slop-lab/dim-control-plane-plugin-git-repositories/plugin-api";
import type {
  AuthoritativeNativeReviewEnvelope,
  AuthoritativeNativeReviewIdentity,
} from "@slop-lab/gs-review-contracts/dim-legacy-codec";
import type { ReviewAttachment } from "@slop-lab/gs-review-contracts";
import type { ReviewChangeMatcher } from "@slop-lab/gs-review";
import type { inspectAuthoritativeNativeReviewGit } from "./authoritative-native-review-git.js";
import type { DimGsReviewRuntime } from "./gs-review-runtime.js";

export type { DimGsReviewRuntime } from "./gs-review-runtime.js";

export const reviewPreparationKind = "dim.code-review.preparation";
export type { ReviewAttachment } from "@slop-lab/gs-review-contracts";
export type RepositorySnapshots = Readonly<Record<string, { readonly commit: string; readonly tree: string }>>;

export type ReviewPreparationInput = {
  readonly runtime: RepositoryRuntime;
  readonly selector: {
    readonly projectId: string;
    readonly repositoryId: string;
    readonly proposalRef: string;
    readonly protectedRef?: string;
  };
  readonly target: AuthoritativeNativeRepositoryTarget;
  readonly evidence: Awaited<ReturnType<typeof inspectAuthoritativeNativeReviewGit>>;
  readonly identity: Omit<AuthoritativeNativeReviewIdentity, "inputs">;
};

export type ReviewPreparation = {
  readonly name: string;
  readonly revision?: string;
  prepare(input: ReviewPreparationInput): Promise<{
    readonly inputs: RepositorySnapshots;
    readonly attachment?: ReviewAttachment;
  }>;
  assertCurrent?(input: {
    readonly runtime: RepositoryRuntime;
    readonly review: AuthoritativeNativeReviewIdentity;
    readonly attachment?: ReviewAttachment;
  }): Promise<void>;
  accepted?(input: {
    readonly runtime: RepositoryRuntime;
    readonly envelope: AuthoritativeNativeReviewEnvelope;
    readonly ownerRequestId: string;
  }): Promise<void>;
};

export type CodeReviewRuntime = RepositoryRuntime & {
  readonly reviewPreparations?: readonly ReviewPreparation[];
  readonly reviewChangeMatchers?: readonly ReviewChangeMatcher[];
};

export function reviewPreparationExtension(preparation: ReviewPreparation): ControlPlaneExtension {
  return { kind: reviewPreparationKind, name: preparation.name, value: preparation };
}

export function reviewPreparations(extensions: readonly ControlPlaneExtension[]): readonly ReviewPreparation[] {
  return extensions.filter((entry) => entry.kind === reviewPreparationKind).map((entry) => {
    if (!isReviewPreparation(entry.value)) throw new CodeReviewPluginApiError(`invalid review preparation: ${entry.name}`);
    return entry.value;
  });
}

export type CodeReviewService = {
  readonly name: "code-review";
  createInTransaction(context: RepositoryExtensionContext, input: {
    readonly projectId: string;
    readonly repositoryId: string;
    readonly proposalRef: string;
    readonly protectedRef?: string;
    readonly ownerRequestId?: string;
  }): Promise<AuthoritativeNativeReviewEnvelope>;
  create(context: RepositoryExtensionContext, input: {
    readonly projectId: string;
    readonly repositoryId: string;
    readonly proposalRef: string;
    readonly protectedRef?: string;
    readonly ownerRequestId?: string;
  }): Promise<AuthoritativeNativeReviewEnvelope>;
  gs(context: RepositoryExtensionContext): DimGsReviewRuntime;
};

export async function acceptReviewPreparations(
  runtime: CodeReviewRuntime,
  envelope: AuthoritativeNativeReviewEnvelope,
  ownerRequestId: string,
): Promise<void> {
  for (const preparation of runtime.reviewPreparations ?? []) {
    await preparation.accepted?.({ runtime, envelope, ownerRequestId });
  }
}

export function codeReviewService(extensions: readonly ControlPlaneExtension[]): CodeReviewService {
  const entry = extensions.find((candidate) => candidate.kind === "dim.code-review.service" && candidate.name === "default");
  if (entry === undefined || !isCodeReviewService(entry.value)) {
    throw new CodeReviewPluginApiError("Git review service is required");
  }
  return entry.value;
}

function isReviewPreparation(value: unknown): value is ReviewPreparation {
  return typeof value === "object" && value !== null
    && "name" in value && typeof value.name === "string"
    && "prepare" in value && typeof value.prepare === "function";
}

function isCodeReviewService(value: unknown): value is CodeReviewService {
  return typeof value === "object" && value !== null
    && "name" in value && value.name === "code-review"
    && "createInTransaction" in value && typeof value.createInTransaction === "function"
    && "create" in value && typeof value.create === "function"
    && "gs" in value && typeof value.gs === "function";
}

export * from "./authoritative-native-review-schema.js";
export * from "./authoritative-native-review-store.js";
export * from "./authoritative-native-decision-store.js";
export * from "./native-human-reviewer-freshness.js";
export * from "./authoritative-native-review.js";
export * from "./review-record-storage.js";
export { AuthoritativeNativeReviewAdmissionBusyError } from "./authoritative-native-review-controller.js";
export * from "./change-matchers.js";
export { readAuthoritativeNativeReviewRefs, assertAuthoritativeNativeReviewRefs } from "./authoritative-native-review-git.js";

export class CodeReviewPluginApiError extends Error {
  readonly name = "CodeReviewPluginApiError";
}
