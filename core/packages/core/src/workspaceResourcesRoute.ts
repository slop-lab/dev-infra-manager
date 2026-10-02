import { UserError } from "./errors.js";
import type { LifecycleState } from "./lifecycleState.js";
import type { DimControllerRoute } from "./controller.js";

export function workspaceResourcesRoute(state: LifecycleState): DimControllerRoute {
  return {
    method: "GET",
    path: "/workspace/resources",
    summary: "Read the authenticated workspace resource assignment",
    audiences: ["agent"],
    async handle(context) {
      const url = new URL(context.request.url ?? "/", "http://dim-controller");
      if (url.search !== "") {
        throw new UserError("workspace resources request must not include query parameters");
      }
      if ((context.request.headers["content-length"] !== undefined
        && context.request.headers["content-length"] !== "0")
        || context.request.headers["transfer-encoding"] !== undefined) {
        throw new UserError("workspace resources request must not include a body");
      }
      const record = await state.readWorkspace(context.workspace.name);
      if (record.workspaceId !== context.workspace.id) throw new UserError("workspace identity changed");
      return {
        body: {
          cpuCount: record.cpuCount,
          memory: record.memory,
          pidsLimit: record.pidsLimit
        }
      };
    }
  };
}
