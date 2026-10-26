import { join } from "node:path";
import { tryAcquireKernelGuard } from "@slop-lab/dim-control-plane-core/lock";
import type { RouterConfig } from "./config.js";
import { RouterOperationRejectedError } from "./operation-errors.js";

export async function withRouterOperationGuard<T>(config: RouterConfig, operation: () => Promise<T>): Promise<T> {
  const guard = await tryAcquireKernelGuard(join(config.stateDirectory, "operator-operation.guard"), { timeoutMilliseconds: 5000 });
  if (!guard) throw new RouterOperationRejectedError("another router operator operation is running; retry after it finishes");
  try { return await operation(); }
  finally { await guard.release(); }
}
