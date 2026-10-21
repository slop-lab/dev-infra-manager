import { codeReviewRefUpdatePolicyExtension } from "./ref-update-policy.js";
import { join } from "node:path";
import type { ControlPlanePlugin, PreparedControlPlanePlugin } from "@slop-lab/dim-control-plane-core/plugin-api";
import { repositoryExtension, readNativeProjectRegistrations, type RepositoryExtensionContext } from "@slop-lab/dim-control-plane-plugin-git-repositories/plugin-api";
import { parseCodeReviewConfig, type CodeReviewConfig } from "./config.js";
import { reviewChangeMatchers } from "./change-matchers.js";
import { reviewPreparations, type CodeReviewRuntime } from "./plugin-api.js";
import { createAuthoritativeNativeReview, type AuthoritativeNativeReviewHooks } from "./authoritative-native-review.js";
import { assertConfiguredHumanReviewers } from "./native-human-reviewer-policy.js";
import { createNativeHumanReviewerService, type NativeHumanReviewerHooks } from "./native-human-reviewer-http.js";
import { reconcileNativeProposalRefs, reconcileRegisteredNativeProposals } from "./native-proposal-reconciler.js";
import { createNativeProposalReconciliationLoop } from "./native-proposal-reconciliation-loop.js";
import { assertAuthoritativeNativeReviewStore, readAuthoritativeNativeReviewEnvelopes } from "./authoritative-native-review-store.js";
import { assertAuthoritativeNativeApprovalStore } from "./authoritative-native-approval-store.js";
import { assertAuthoritativeNativeRevocationStore } from "./authoritative-native-revocation-store.js";
import { readAuthoritativeNativeDecisions } from "./authoritative-native-decision-store.js";

export * from "./config.js";
export * from "./policy.js";
export const controlPlanePlugin: ControlPlanePlugin = { apiVersion: 1, name: "code-review", configure(raw) { return prepareCodeReview(parseCodeReviewConfig(raw)); } };
export function prepareCodeReview(config: CodeReviewConfig, hooks: { readonly review?: AuthoritativeNativeReviewHooks; readonly humanReviewer?: NativeHumanReviewerHooks } = {}): PreparedControlPlanePlugin {
    let attached: RepositoryExtensionContext | undefined;
    const service = {
      async create(context: RepositoryExtensionContext, input: { readonly projectId: string; readonly repositoryId: string; readonly proposalRef: string }) {
        return context.serialize(() => createAuthoritativeNativeReview({ ...context.runtime, reviewPreparations: reviewPreparations(context.extensions), reviewChangeMatchers: reviewChangeMatchers(context.extensions) }, input, hooks.review));
      }
    };
    return {
      requiresExtensions: [{ kind: "dim.git-repositories.service", name: "default" }],
      extensions: [
        codeReviewRefUpdatePolicyExtension,
        { kind: "dim.code-review.service", name: "default", value: service },
        { kind: "dim.webhooks.event-source", name: "code-review", value: { name: "code-review", async read() {
          if (attached === undefined || !attached.available() || !attached.runtime.activated()) return [];
          const context = attached;
          return context.serialize(async () => {
            const events = [];
            for (const registration of readNativeProjectRegistrations(context.runtime.state)) {
              if (registration.phase !== "repository-prepared") continue;
              const repository = join(context.stateDirectory, registration.projectId, `${registration.repositoryId}.git`);
              for (const { review } of await readAuthoritativeNativeReviewEnvelopes(repository)) events.push({
                identity: review.reviewId, projectId: review.projectId, type: "dev.dim.git.review.created",
                subject: `projects/${review.projectId}/repositories/${review.repositoryId}`,
                data: { projectId: review.projectId, repositoryId: review.repositoryId, reviewId: review.reviewId, proposalRef: review.proposalRef, protectedRef: review.protectedRef, expectedCommit: review.expectedProtectedHead, candidateCommit: review.candidateCommit, candidateTree: review.candidateTree, policyRevision: review.policyRevision, createdAt: review.createdAt }
              });
            }
            return events;
          });
        } } },
        repositoryExtension({ name: "code-review", policyName: "code-review", requiresRefUpdatePolicies: ["code-review"], credentials: config.humanReviewers,
          async attach(context) {
            attached = context;
            const runtime: CodeReviewRuntime = { ...context.runtime, reviewPreparations: reviewPreparations(context.extensions), reviewChangeMatchers: reviewChangeMatchers(context.extensions) };
            for (const registration of readNativeProjectRegistrations(runtime.state)) {
              const repository = join(context.stateDirectory, registration.projectId, `${registration.repositoryId}.git`);
              await assertAuthoritativeNativeReviewStore(repository); await assertAuthoritativeNativeApprovalStore(repository);
              await assertAuthoritativeNativeRevocationStore(repository); await readAuthoritativeNativeDecisions(repository);
            }
            let healthy = true;
            const reconcile = () => reconcileRegisteredNativeProposals(runtime, hooks.review).then(() => undefined);
            const retry = createNativeProposalReconciliationLoop({ reconcile: () => context.serialize(reconcile), unavailable() { healthy = false; } });
            const http = createNativeHumanReviewerService({ config, knownCredentials: context.knownCredentials, runtime, serialize: context.serialize, ...(hooks.humanReviewer === undefined ? {} : { hooks: hooks.humanReviewer }) });
            return {
              handle: http.handle,
              validatePolicy(policy) { if (Object.hasOwn(policy.extensions, "code-review")) assertConfiguredHumanReviewers(config, policy, runtime.reviewChangeMatchers); },
              async activate() { await reconcile(); },
              async onProposals(projectId, repositoryId, refs) { try { await reconcileNativeProposalRefs(runtime, projectId, repositoryId, refs, hooks.review); } catch (error) { retry.wake(); throw error; } },
              healthy: () => healthy,
              async close() { attached = undefined; await retry.close(); }
            };
          }
        })
      ],
      async start() { return { async close() {} }; }
    };
}
