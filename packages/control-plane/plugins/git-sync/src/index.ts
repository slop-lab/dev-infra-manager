import { z } from "zod";
import type { ControlPlanePlugin } from "@slop-lab/dim-control-plane-core/plugin-api";
import {
  createGsRepositoryServiceAdapter,
  nativeBasicAuthorized,
  NativeGitBundleHttpError,
  readBoundedJson,
  repositoryExtension,
  sendJson,
} from "@slop-lab/dim-control-plane-plugin-git-repositories/plugin-api";
import {
  createNodeGitSyncTransport,
  createSyncService,
  GitSyncOperationError,
  parseGitSyncPolicy,
  type RepositoryPrincipalScope,
} from "@slop-lab/gs-sync";
import { gitSyncConfigurationSchema } from "./config.js";

export * from "./config.js";

export const controlPlanePlugin: ControlPlanePlugin = {
  apiVersion: 1,
  name: "git-sync",
  configure(raw) {
    const config = gitSyncConfigurationSchema.parse(raw);
    const values = config.operators.flatMap(({ username, password }) => [username, password]);
    if (new Set(values).size !== values.length || new Set(config.operators.map(({ hostId }) => hostId)).size !== config.operators.length) {
      throw new Error("git-sync operator credentials and host identities must be unique");
    }
    return {
      requiresExtensions: [{ kind: "dim.git-repositories.service", name: "default" }],
      extensions: [repositoryExtension({
        name: "git-sync",
        policyName: "git-sync",
        requiresMergeQualityGuard: false,
        credentials: config.operators,
        async attach(context) {
          const adapter = createGsRepositoryServiceAdapter(context);
          const git = createNodeGitSyncTransport({
            gitExecutable: context.runtime.gitExecutable,
            gitIdentity: context.runtime.gitIdentity,
            allowLocalRemotes: config.allowLocalRemotes,
            ...(config.credential === undefined ? {} : { remoteAuthorization: {
              async authorize(url: URL) {
                if (url.protocol !== "https:") return undefined;
                return {
                  headerName: "Authorization",
                  headerValue: `Basic ${Buffer.from(`${config.credential?.username}:${config.credential?.password}`).toString("base64")}`,
                };
              },
            } }),
          });
          const service = createSyncService({
            mutationGate: adapter.mutationGate,
            proposalConsumer: { consume: ({ selector, refs }) => context.reconcileProposals(selector.namespaceId, selector.repositoryId, refs) },
            git,
            currentAuthorityEpoch: () => context.runtime.expectedGenerationId,
          });
          return {
            validatePolicy(policy) {
              if (Object.hasOwn(policy.extensions, "git-sync")) parseGitSyncPolicy(policy.extensions["git-sync"], config.allowLocalRemotes);
            },
            async handle(request, response, url) {
              const identity = request.method === "GET" && url.pathname === "/v1/git-sync-operator-identity" && url.search === "";
              const route = request.method === "POST" && url.search === ""
                ? /^\/v1\/projects\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\/repositories\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\/sync\/(fetch|merge|publish)$/.exec(url.pathname)
                : null;
              if (!identity && route === null) return false;
              const operator = config.operators.find((candidate) => nativeBasicAuthorized(request, candidate));
              if (operator === undefined) {
                const known = context.knownCredentials.some((candidate) => nativeBasicAuthorized(request, candidate));
                sendJson(response, known ? 403 : 401, { error: known ? "forbidden" : "unauthorized" });
                return true;
              }
              if (identity) {
                sendJson(response, 200, {
                  schemaVersion: 1,
                  serviceId: "native-main",
                  role: "git-sync-operator",
                  hostId: operator.hostId,
                  generationId: context.runtime.expectedGenerationId,
                });
                return true;
              }
              const namespaceId = route?.[1];
              const repositoryId = route?.[2];
              const operation = route?.[3];
              if (namespaceId === undefined || repositoryId === undefined || operation === undefined) return false;
              try {
                const body = z.object({ schemaVersion: z.literal(1), protectedRef: z.string().startsWith("refs/heads/").max(1024).optional() }).strict().parse(await readBoundedJson(request));
                if (request.headers["x-dim-generation-id"] !== context.runtime.expectedGenerationId) {
                  sendJson(response, 409, { error: "git-sync generation conflicts with service startup" });
                  return true;
                }
                const principal: RepositoryPrincipalScope = {
                  principalId: operator.hostId,
                  async authorize(target) {
                    if (target.ownerPrincipalId !== operator.hostId) throw new SyncRepositoryNotFoundError();
                  },
                };
                const selectedOperation = operation === "merge" ? "propose" : operation === "fetch" ? "fetch" : "publish";
                const result = await service.synchronize({
                  namespaceId,
                  repositoryId,
                  principal,
                  operation: selectedOperation,
                  ...(body.protectedRef === undefined ? {} : { protectedRef: body.protectedRef }),
                });
                sendJson(response, 200, result);
              } catch (error) {
                if (error instanceof SyncRepositoryNotFoundError) sendJson(response, 404, { error: "repository not found" });
                else if (error instanceof z.ZodError || error instanceof NativeGitBundleHttpError) sendJson(response, 400, { error: "git-sync request is invalid" });
                else if (error instanceof GitSyncOperationError) sendJson(response, 409, { error: "Git synchronization failed; check reviewed policy, remote authorization, upstream divergence and proposal state" });
                else throw error;
              }
              return true;
            },
            async close() {},
          };
        },
      })],
      async start() { return { async close() {} }; },
    };
  },
};

class SyncRepositoryNotFoundError extends Error {
  readonly name = "SyncRepositoryNotFoundError";
}
