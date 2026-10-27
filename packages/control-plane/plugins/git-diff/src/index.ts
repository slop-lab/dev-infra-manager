import { z } from "zod";
import type { ControlPlanePlugin, PreparedControlPlanePlugin } from "@slop-lab/dim-control-plane-core/plugin-api";
import { repositoryExtension, repositoryAccessProvider, RepositoryAccessError, readBoundedJson, sendJson, NativeGitBundleHttpError } from "@slop-lab/dim-control-plane-plugin-git-repositories/plugin-api";
import { gitDiffServiceKind } from "./plugin-api.js";
import { snapshot } from "./snapshot.js";
import { RepositoryReadError } from "@slop-lab/dim-control-plane-plugin-git-repositories/plugin-api";
export * from "./plugin-api.js";
const bodySchema = z.object({ baseCommit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/), headCommit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/) }).strict();
export const controlPlanePlugin: ControlPlanePlugin = {
  apiVersion: 1, name: "git-diff",
  configure(raw) { z.object({}).strict().parse(raw); return prepareGitDiff(); }
};
export function prepareGitDiff(): PreparedControlPlanePlugin {
  return {
    requiresExtensions: [{ kind: "dim.git-repositories.service", name: "default" }, { kind: "dim.git-repositories.access", name: "default" }],
    extensions: [
      { kind: "dim.git-repositories.feature", name: "git-diff", value: { version: 1 } },
      { kind: gitDiffServiceKind, name: "default", value: { snapshot } },
      repositoryExtension({ name: "git-diff", async attach(context) {
        const access = repositoryAccessProvider(context.extensions);
        return {
          async handle(request, response, url) {
            const match = /^\/v1\/projects\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\/repositories\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\/diff$/.exec(url.pathname);
            if (!match || request.method !== "POST" || url.search !== "") return false;
            try {
              await context.read(async () => {
                await access.authorize(context, request, { projectId: match[1]!, repositoryId: match[2]! });
                const body = bodySchema.parse(await readBoundedJson(request));
                const result = await snapshot(context, { projectId: match[1]!, repositoryId: match[2]!, ...body });
                // Recheck revocation and live policy after potentially expensive object reads.
                await access.authorize(context, request, { projectId: match[1]!, repositoryId: match[2]! });
                sendJson(response, 200, result);
              });
            } catch (error) {
              if (error instanceof RepositoryAccessError) sendJson(response, error.status, { error: error.message });
              else if (error instanceof z.ZodError || error instanceof NativeGitBundleHttpError) sendJson(response, 400, { error: "diff request is invalid" });
              else if (error instanceof RepositoryReadError) sendJson(response, 422, { error: error.message });
              else sendJson(response, 503, { error: "repository diff is unavailable or exceeds its limits" });
            }
            return true;
          },
          async close() {}
        };
      } })
    ],
    async start() { return { async close() {} }; }
  };
}
