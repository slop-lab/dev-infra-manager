import type { ControlPlanePlugin } from "@slop-lab/dim-control-plane-core/plugin-api";
import { reviewTraceRuntimeExtension } from "@slop-lab/dim-git-review-tracing/plugin-api";
import { createNodeReviewTraceRuntime } from "@slop-lab/dim-git-review-tracing-runtime-node";

export { createNodeReviewTraceRuntime } from "@slop-lab/dim-git-review-tracing-runtime-node";

export const controlPlanePlugin: ControlPlanePlugin = {
  apiVersion: 1,
  name: "review-tracing-node",
  async configure(raw) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).length !== 0) throw new Error("review-tracing-node configuration must be an empty object");
    return {
      extensions: [reviewTraceRuntimeExtension(await createNodeReviewTraceRuntime())],
      async start() { return { async close() {} }; }
    };
  }
};
