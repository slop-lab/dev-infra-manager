/** Optional server-side CI administration ports; clients never expose credentials. */
export { createCiQueryClient } from "./queryClient.js";
export { createCiOperatorClient } from "./operator.js";
export type { ExecutionSummary } from "@slop-lab/dim-contracts-ci/query";
