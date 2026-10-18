import { UserError } from "@slop-lab/dim-core";
import type { LifecycleOptions } from "./lifecycleTypes.js";
import type { RegisteredDimPlugins } from "./plugin.js";
import type { StreamingCommandRunner } from "@slop-lab/dim-core";

/** Host administration exposes plugin management; workspace lifecycle belongs to core. */
export async function adminBuiltinCall(operation: string, context: {
  readonly input: Record<string, unknown>;
  readonly lifecycle: LifecycleOptions;
  readonly runner: StreamingCommandRunner;
  readonly plugins: RegisteredDimPlugins;
}): Promise<unknown> {
  if (operation !== "plugin.list") throw new UserError(`unknown admin operation '${operation}'`);
  return {
    plugins: context.plugins.plugins.filter((name) => !name.startsWith("builtin.")),
    controllerRoutes: context.plugins.controllerRoutes.map((route) => `${route.method} /api${route.path}`),
    adminRoutes: context.plugins.adminRoutes.map((route) => `${route.method} /v1${route.path}`)
  };
}
