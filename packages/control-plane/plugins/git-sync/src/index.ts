import { z } from "zod";
import type { ControlPlanePlugin } from "@slop-lab/dim-control-plane-core/plugin-api";
import { repositoryExtension, nativeBasicAuthorized, readBoundedJson, sendJson, resolveAuthoritativeNativeRepositoryTarget,
  exactActivationIsBound, NativeGitBundleHttpError } from "@slop-lab/dim-control-plane-plugin-git-repositories/plugin-api";
import { gitSyncConfigurationSchema, parseGitSyncPolicy } from "./config.js";
import { synchronizeRepository, type GitSyncOperation } from "./operations.js";
export * from "./config.js";
export { synchronizeRepository } from "./operations.js";

export const controlPlanePlugin: ControlPlanePlugin = {
  apiVersion: 1, name: "git-sync",
  configure(raw) {
    const config = gitSyncConfigurationSchema.parse(raw);
    const values = config.operators.flatMap(({ username, password }) => [username, password]);
    if (new Set(values).size !== values.length || new Set(config.operators.map(({ hostId }) => hostId)).size !== config.operators.length) {
      throw new Error("git-sync operator credentials and host identities must be unique");
    }
    return {
      requiresExtensions: [{ kind: "dim.git-repositories.service", name: "default" }],
      extensions: [repositoryExtension({ name: "git-sync", policyName: "git-sync", requiresMergeQualityGuard: false, credentials: config.operators,
        async attach(context) {
          return {
            validatePolicy(policy) { if (Object.hasOwn(policy.extensions, "git-sync")) parseGitSyncPolicy(policy.extensions["git-sync"], config.allowLocalRemotes); },
            async handle(request, response, url) {
              const identity = request.method === "GET" && url.pathname === "/v1/git-sync-operator-identity" && url.search === "";
              const route = request.method === "POST" && url.search === ""
                ? /^\/v1\/projects\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\/repositories\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\/sync\/(fetch|merge|publish)$/.exec(url.pathname) : null;
              if (!identity && route === null) return false;
              const operator = config.operators.find((candidate) => nativeBasicAuthorized(request, candidate));
              if (!operator) {
                const known = context.knownCredentials.some((candidate) => nativeBasicAuthorized(request, candidate));
                sendJson(response, known ? 403 : 401, { error: known ? "forbidden" : "unauthorized" }); return true;
              }
              if (identity) {
                sendJson(response, 200, { schemaVersion: 1, serviceId: "native-main", role: "git-sync-operator", hostId: operator.hostId,
                  generationId: context.runtime.expectedGenerationId }); return true;
              }
              let validBody = false;
              let protectedRef: string | undefined;
              try { const body = z.object({ schemaVersion: z.literal(1), protectedRef: z.string().startsWith("refs/heads/").max(1024).optional() }).strict().parse(await readBoundedJson(request)); protectedRef = body.protectedRef; validBody = true; }
              catch (error) { if (!(error instanceof z.ZodError || error instanceof NativeGitBundleHttpError)) throw error; }
              if (!validBody) { sendJson(response, 400, { error: "git-sync request is invalid" }); return true; }
              const projectId = route![1]!, repositoryId = route![2]!, operation = route![3]! as GitSyncOperation;
              await context.serialize(async () => {
                if (request.headers["x-dim-generation-id"] !== context.runtime.expectedGenerationId) {
                  sendJson(response, 409, { error: "git-sync generation conflicts with service startup" }); return;
                }
                if (!context.available() || !context.runtime.activated() || !exactActivationIsBound(context.runtime.state,
                  context.runtime.expectedGenerationId, context.runtime.activationTokenDigest)) {
                  sendJson(response, 503, { error: "git-sync requires exact generation activation" }); return;
                }
                let target;
                try { target = await resolveAuthoritativeNativeRepositoryTarget(context.runtime, { projectId, repositoryId }); }
                catch { sendJson(response, 404, { error: "repository not found" }); return; }
                if (target.imported.ownerHostId !== operator.hostId) { sendJson(response, 404, { error: "repository not found" }); return; }
                try { sendJson(response, 200, await synchronizeRepository(context, config, { projectId, repositoryId, ...(protectedRef === undefined ? {} : { protectedRef }) }, operation)); }
                catch { sendJson(response, 409, { error: "Git synchronization failed; check reviewed policy, remote authorization, upstream divergence and proposal state" }); }
              });
              return true;
            },
            async close() {}
          };
        }
      })],
      async start() { return { async close() {} }; }
    };
  }
};
