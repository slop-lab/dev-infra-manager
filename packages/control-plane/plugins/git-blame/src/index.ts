import { z } from "zod";
import type { IncomingMessage } from "node:http";
import { gitBlameRequestSchema } from "@slop-lab/gs-blame";
import { BlameServiceError, createBlameService, type BlameService, type RepositoryPrincipalScope } from "@slop-lab/gs-blame-service";
import type { ControlPlanePlugin, PreparedControlPlanePlugin } from "@slop-lab/dim-control-plane-core/plugin-api";
import {
  createGsRepositoryServiceAdapter,
  NativeGitBundleHttpError,
  readBoundedJson,
  repositoryAccessProvider,
  repositoryExtension,
  RepositoryAccessError,
  RepositoryReadError,
  repositoryReadHistoryRefs,
  sendJson,
  type RepositoryExtensionContext,
} from "@slop-lab/dim-control-plane-plugin-git-repositories/plugin-api";

export const controlPlanePlugin: ControlPlanePlugin = {
  apiVersion: 1,
  name: "git-blame",
  configure(raw) {
    z.object({}).strict().parse(raw);
    return prepareGitBlame();
  },
};

export function prepareGitBlame(): PreparedControlPlanePlugin {
  return {
    requiresExtensions: [
      { kind: "dim.git-repositories.service", name: "default" },
      { kind: "dim.git-repositories.access", name: "default" },
    ],
    extensions: [
      { kind: "dim.git-repositories.feature", name: "git-blame", value: { version: 1 } },
      repositoryExtension({
        name: "git-blame",
        async attach(context) {
          const adapter = createGsRepositoryServiceAdapter(context);
          const service = createBlameService({
            readGate: adapter.readGate,
            reader: adapter.reader,
            historyRefs: (selector) => repositoryReadHistoryRefs(context, { projectId: selector.namespaceId, repositoryId: selector.repositoryId }),
          });
          return {
            async close() {},
            handle: (request, response, url) => handle(context, service, request, response, url),
          };
        },
      }),
    ],
    async start() { return { async close() {} }; },
  };
}

async function handle(context: RepositoryExtensionContext, service: BlameService, request: IncomingMessage, response: import("node:http").ServerResponse, url: URL): Promise<boolean> {
  const match = /^\/v1\/projects\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\/repositories\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\/blame$/.exec(url.pathname);
  if (match === null || request.method !== "POST" || url.search !== "") return false;
  const namespaceId = match[1];
  const repositoryId = match[2];
  if (namespaceId === undefined || repositoryId === undefined) return false;
  try {
    const body = gitBlameRequestSchema.parse(await readBoundedJson(request));
    const principal = await principalScope(context, request, namespaceId, repositoryId);
    sendJson(response, 200, await service.line({ namespaceId, repositoryId, principal, ...body }));
  } catch (error) {
    if (error instanceof RepositoryAccessError) sendJson(response, error.status, { error: error.message });
    else if (error instanceof z.ZodError || error instanceof NativeGitBundleHttpError) sendJson(response, 400, { error: "blame request is invalid" });
    else if (error instanceof RepositoryReadError || error instanceof BlameServiceError) sendJson(response, 422, { error: error.message });
    else sendJson(response, 503, { error: "repository attribution is unavailable or exceeds its limits" });
  }
  return true;
}

async function principalScope(context: RepositoryExtensionContext, request: IncomingMessage, namespaceId: string, repositoryId: string): Promise<RepositoryPrincipalScope> {
  const access = repositoryAccessProvider(context.extensions);
  const initial = await access.authorize(context, request, { projectId: namespaceId, repositoryId });
  return {
    principalId: initial.actorId,
    async authorize(target) {
      const current = await access.authorize(context, request, { projectId: namespaceId, repositoryId, protectedRef: target.head.protectedRef });
      if (current.actorId !== initial.actorId) throw new RepositoryAccessError(403, "repository principal changed during request");
    },
  };
}
