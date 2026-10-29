import type { CodeReviewRuntime } from "@slop-lab/dim-control-plane-plugin-git-review/plugin-api";
import type { WorkflowCompiler } from "@slop-lab/gs-ci-contracts";
export type GitCiRuntime = CodeReviewRuntime & { readonly workflowCompiler: WorkflowCompiler };
