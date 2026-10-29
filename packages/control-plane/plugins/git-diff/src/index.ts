import { z } from "zod";
import type { IncomingMessage } from "node:http";
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
  type GsRepositoryServiceAdapter,
  type RepositoryExtensionContext,
} from "@slop-lab/dim-control-plane-plugin-git-repositories/plugin-api";
import { createDiffService, DiffServiceError, type DiffService, type RepositoryPrincipalScope } from "@slop-lab/gs-diff-service";
import { gitDiffServiceKind } from "./plugin-api.js";

export * from "./plugin-api.js";

const bodySchema = z.object({
  baseCommit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  headCommit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
}).strict();

export const controlPlanePlugin: ControlPlanePlugin = {
  apiVersion: 1,
  name: "git-diff",
  configure(raw) {
    z.object({}).strict().parse(raw);
    return prepareGitDiff();
  },
};

export function prepareGitDiff(): PreparedControlPlanePlugin {
  let service: DiffService | undefined;
  let adapter: GsRepositoryServiceAdapter | undefined;
  return {
    requiresExtensions: [
      { kind: "dim.git-repositories.service", name: "default" },
      { kind: "dim.git-repositories.access", name: "default" },
    ],
    extensions: [
      { kind: "dim.git-repositories.feature", name: "git-diff", value: { version: 1 } },
      { kind: gitDiffServiceKind, name: "default", value: {
        gs: () => required(service),
        snapshotInTransaction: (request: Parameters<DiffService["snapshot"]>[0]) => requiredAdapter(adapter)
          .withBorrowedMutation(request, (access) => required(service).snapshotInTransaction(access, request)),
      } },
      repositoryExtension({
        name: "git-diff",
        async attach(context) {
          const ownedAdapter = createGsRepositoryServiceAdapter(context);
          const owned = createDiffService({
            readGate: ownedAdapter.readGate,
            reader: ownedAdapter.reader,
            historyRefs: (selector) => repositoryReadHistoryRefs(context, { projectId: selector.namespaceId, repositoryId: selector.repositoryId }),
          });
          service = owned;
          adapter = ownedAdapter;
          return {
            async close() { if (service === owned) { service = undefined; adapter = undefined; } },
            handle: (request, response, url) => handle(context, owned, request, response, url),
          };
        },
      }),
    ],
    async start() { return { async close() {} }; },
  };
}

async function handle(context: RepositoryExtensionContext, service: DiffService, request: IncomingMessage, response: import("node:http").ServerResponse, url: URL): Promise<boolean> {
  const match = /^\/v1\/projects\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\/repositories\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\/diff$/.exec(url.pathname);
  if (match === null || request.method !== "POST" || url.search !== "") return false;
  const namespaceId = match[1];
  const repositoryId = match[2];
  if (namespaceId === undefined || repositoryId === undefined) return false;
  try {
    const principal = await principalScope(context, request, namespaceId, repositoryId);
    const body = bodySchema.parse(await readBoundedJson(request));
    sendJson(response, 200, await service.snapshot({ namespaceId, repositoryId, principal, ...body }));
  } catch (error) {
    if (error instanceof RepositoryAccessError) sendJson(response, error.status, { error: error.message });
    else if (error instanceof z.ZodError || error instanceof NativeGitBundleHttpError) sendJson(response, 400, { error: "diff request is invalid" });
    else if (error instanceof RepositoryReadError || error instanceof DiffServiceError) sendJson(response, 422, { error: error.message });
    else sendJson(response, 503, { error: "repository diff is unavailable or exceeds its limits" });
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

function required(service: DiffService | undefined): DiffService {
  if (service === undefined) throw new DiffServiceError("Git diff service is unavailable");
  return service;
}

function requiredAdapter(adapter: GsRepositoryServiceAdapter | undefined): GsRepositoryServiceAdapter {
  if (adapter === undefined) throw new DiffServiceError("Git diff service is unavailable");
  return adapter;
}
