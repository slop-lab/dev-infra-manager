import type { CodeReviewRuntime } from "@slop-lab/dim-control-plane-plugin-git-review/plugin-api";
import type { WorkflowCompiler } from "@slop-lab/dim-contracts-ci/workflow-plugin-api";
export type GitCiRuntime = CodeReviewRuntime & { readonly workflowCompiler: WorkflowCompiler };
