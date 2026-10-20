import type { CodeReviewRuntime } from "@slop-lab/dim-control-plane-plugin-code-review/extensions";
import type { WorkflowCompiler } from "@slop-lab/dim-contracts-ci/workflow";
export type GitCiRuntime = CodeReviewRuntime & { readonly workflowCompiler: WorkflowCompiler };
