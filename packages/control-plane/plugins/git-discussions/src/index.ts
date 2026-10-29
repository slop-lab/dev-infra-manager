import type { IncomingMessage } from "node:http";
import { z } from "zod";
import { discussionAnchorSchema } from "@slop-lab/gs-discussions";
import { createDiscussionsService, DiscussionsNotFoundError } from "@slop-lab/gs-discussions-service";
import type { RepositoryPrincipalScope } from "@slop-lab/gs-pull-request-service";
import { PullRequestConflict } from "@slop-lab/gs-pull-requests";
import type { ControlPlanePlugin } from "@slop-lab/dim-control-plane-core/plugin-api";
import {
  createGsRepositoryServiceAdapter,
  NativeGitBundleHttpError,
  readBoundedJson,
  repositoryAccessProvider,
  repositoryExtension,
  RepositoryAccessError,
  sendJson,
  type RepositoryExtensionContext,
} from "@slop-lab/dim-control-plane-plugin-git-repositories/plugin-api";
import { pullRequestService } from "@slop-lab/dim-control-plane-plugin-git-pull-requests/plugin-api";
import { gitDiffService } from "@slop-lab/dim-control-plane-plugin-git-diff/plugin-api";

const comment = z.object({
  expectedVersion: z.number().int().positive(),
  revisionId: z.string().uuid(),
  body: z.string().trim().min(1).max(3000),
  anchor: discussionAnchorSchema.optional(),
}).strict();
const selector = "([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)";
const route = new RegExp(`^/v1/projects/${selector}/repositories/${selector}/pull-requests/([0-9a-f-]{36})/comments$`);

export const controlPlanePlugin: ControlPlanePlugin = {
  apiVersion: 1,
  name: "git-discussions",
  configure(raw) {
    z.object({}).strict().parse(raw);
    return {
      requiresExtensions: [
        { kind: "dim.git-pull-requests.service", name: "default" },
        { kind: "dim.git-diff.service", name: "default" },
        { kind: "dim.git-repositories.access", name: "default" },
      ],
      extensions: [
        { kind: "dim.git-repositories.feature", name: "git-discussions", value: { version: 1 } },
        repositoryExtension({
          name: "git-discussions",
          async attach(context) {
            const adapter = createGsRepositoryServiceAdapter(context);
            return {
              async close() {},
              handle: (request, response, url) => handle(context, adapter.mutationGate, request, response, url),
            };
          },
        }),
      ],
      async start() { return { async close() {} }; },
    };
  },
};

async function handle(context: RepositoryExtensionContext, mutationGate: Parameters<typeof createDiscussionsService>[0]["mutationGate"], request: IncomingMessage, response: import("node:http").ServerResponse, url: URL): Promise<boolean> {
  const match = url.search === "" ? route.exec(url.pathname) : null;
  if (match === null) return false;
  if (request.method !== "POST") {
    sendJson(response, 405, { error: "Method not allowed" });
    return true;
  }
  const namespaceId = match[1];
  const repositoryId = match[2];
  const requestId = match[3];
  if (namespaceId === undefined || repositoryId === undefined || requestId === undefined) return false;
  try {
    const service = createDiscussionsService({
      mutationGate,
      pullRequests: pullRequestService(context.extensions).gs(),
      diff: (() => {
        const bridge = gitDiffService(context.extensions);
        const diff = bridge.gs();
        return { snapshot: diff.snapshot, snapshotInTransaction: (_access, request) => bridge.snapshotInTransaction(request) };
      })(),
    });
    const body = comment.parse(await readBoundedJson(request));
    const principal = await principalScope(context, request, namespaceId, repositoryId);
    sendJson(response, 201, await service.addComment({ namespaceId, repositoryId, requestId, principal,
      expectedVersion: body.expectedVersion, revisionId: body.revisionId, body: body.body,
      ...(body.anchor === undefined ? {} : { anchor: body.anchor }) }));
  } catch (error) {
    if (error instanceof RepositoryAccessError) sendJson(response, error.status, { error: error.message });
    else if (error instanceof DiscussionsNotFoundError) sendJson(response, 404, { error: error.message });
    else if (error instanceof PullRequestConflict) sendJson(response, 409, { error: error.message });
    else if (error instanceof z.ZodError || error instanceof NativeGitBundleHttpError) sendJson(response, 400, { error: "Invalid discussion input" });
    else throw error;
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
