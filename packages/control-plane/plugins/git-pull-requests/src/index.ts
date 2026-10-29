import { z } from "zod";
import type { IncomingMessage } from "node:http";
import type { ControlPlanePlugin } from "@slop-lab/dim-control-plane-core/plugin-api";
import type { BorrowedRepositoryMutationAccess } from "@slop-lab/gs-repository-service";
import type { ReviewEnvelope, ReviewRequest } from "@slop-lab/gs-review-contracts";
import {
  createGsRepositoryServiceAdapter,
  gitBytes,
  NativeGitBundleHttpError,
  readNativeProjectRegistrations,
  readBoundedJson,
  repositoryAccessProvider,
  repositoryExtension,
  RepositoryAccessError,
  sendJson,
  type RepositoryExtensionContext,
} from "@slop-lab/dim-control-plane-plugin-git-repositories/plugin-api";
import {
  openPullRequestService,
  PullRequestNotFoundError,
  PullRequestReviewUnavailableError,
  PullRequestStore,
  recordRefs,
  type PullRequestRefWriter,
  type PullRequestService,
  type RepositoryPrincipalScope,
} from "@slop-lab/gs-pull-request-service";
import { isCandidateRef } from "@slop-lab/gs-repository-contracts";
import { PullRequestConflict } from "@slop-lab/gs-pull-requests";
import { pullRequestServiceKind } from "./plugin-api.js";

const version = z.object({ expectedVersion: z.number().int().positive() }).strict();
const create = z.object({
  title: z.string().trim().min(1).max(240),
  body: z.string().max(3000).default(""),
  sourceRef: z.string().max(1024).refine(isCandidateRef),
  targetRef: z.string().startsWith("refs/heads/").max(1024).optional(),
}).strict();
const edit = version.extend({
  title: z.string().trim().min(1).max(240).optional(),
  body: z.string().max(3000).optional(),
  state: z.enum(["open", "closed"]).optional(),
}).strict();
const selector = "([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)";
const route = new RegExp(`^/v1/projects/${selector}/repositories/${selector}/pull-requests(?:/([0-9a-f-]{36})(?:/(refresh|review))?)?$`);

export const controlPlanePlugin: ControlPlanePlugin = {
  apiVersion: 1,
  name: "git-pull-requests",
  configure(raw) {
    z.object({}).strict().parse(raw);
    let service: PullRequestService | undefined;
    return {
      requiresExtensions: [
        { kind: "dim.git-repositories.service", name: "default" },
        { kind: "dim.git-repositories.access", name: "default" },
      ],
      extensions: [
        {
          kind: "dim.git-repositories.read-history",
          name: "git-pull-requests",
          value: { refs: async (_context: RepositoryExtensionContext, scope: { projectId: string; repositoryId: string }) =>
            service === undefined ? [] : (await service.ownedRefs({ namespaceId: scope.projectId, repositoryId: scope.repositoryId })).map((entry) => entry.ref) },
        },
        { kind: "dim.git-repositories.feature", name: "git-pull-requests", value: { version: 1 } },
        { kind: pullRequestServiceKind, name: "default", value: { gs: () => required(service) } },
        repositoryExtension({
          name: "git-pull-requests",
          ownedRefs: async (directory, scope) => (await new PullRequestStore(directory).list(scope.projectId, scope.repositoryId)).flatMap(recordRefs),
          async attach(context) {
            const adapter = createGsRepositoryServiceAdapter(context);
            const review = optionalReviewService(context);
            const writer = refWriter(context);
            const owned = openPullRequestService({
              stateDirectory: context.extensionStateDirectory,
              readGate: adapter.readGate,
              mutationGate: adapter.mutationGate,
              reader: adapter.reader,
              refWriter: writer,
              ...(review === undefined ? {} : { reviewRequest: { request: ({ access, request }) => review.createInTransaction(access, request) } }),
            });
            const ownerPrincipal: RepositoryPrincipalScope = { principalId: "dim-pull-request-owner", async authorize() {} };
            service = owned;
            return {
              async activate() {
                for (const registration of readNativeProjectRegistrations(context.runtime.state)) {
                  const selector = { namespaceId: registration.projectId, repositoryId: registration.repositoryId };
                  if ((await owned.ownedRefs(selector)).length === 0) continue;
                  // Activation already owns repository serialization; borrow it rather than reacquiring the mutation gate.
                  await adapter.withBorrowedMutation(selector, (access) => owned.repairPinsInTransaction(access, { ...selector, principal: ownerPrincipal }));
                }
              },
              async close() { if (service === owned) service = undefined; },
              handle: (request, response, url) => handle(context, owned, request, response, url),
            };
          },
        }),
      ],
      async start() { return { async close() {} }; },
    };
  },
};

async function handle(context: RepositoryExtensionContext, service: PullRequestService, request: IncomingMessage, response: import("node:http").ServerResponse, url: URL): Promise<boolean> {
  const match = url.search === "" ? route.exec(url.pathname) : null;
  if (match === null) return false;
  const namespaceId = match[1];
  const repositoryId = match[2];
  if (namespaceId === undefined || repositoryId === undefined) return false;
  const requestId = match[3];
  const operation = match[4];
  if (!((request.method === "GET" && operation === undefined)
    || (request.method === "POST" && (requestId === undefined || operation !== undefined))
    || (request.method === "PATCH" && requestId !== undefined && operation === undefined))) {
    sendJson(response, 405, { error: "Method not allowed" });
    return true;
  }
  try {
    const body = request.method === "GET" ? undefined : await readBoundedJson(request);
    const principal = await principalScope(context, request, { namespaceId, repositoryId });
    if (requestId === undefined) {
      if (request.method === "GET") sendJson(response, 200, (await service.list({ namespaceId, repositoryId, principal })).slice(0, 100));
      else {
        const input = create.parse(body);
        const outcome = await service.createWithOutcome({ namespaceId, repositoryId, principal, title: input.title, body: input.body,
          sourceRef: input.sourceRef, ...(input.targetRef === undefined ? {} : { targetRef: input.targetRef }) });
        sendJson(response, outcome.created ? 201 : 200, outcome.record);
      }
      return true;
    }
    if (request.method === "GET") {
      const record = await service.read({ namespaceId, repositoryId, principal, requestId });
      sendJson(response, record === undefined ? 404 : 200, record ?? { error: "Pull request not found" });
    } else if (operation === "refresh") {
      sendJson(response, 200, await service.refresh({ namespaceId, repositoryId, principal, requestId, ...version.parse(body) }));
    } else if (operation === "review") {
      sendJson(response, 200, await service.requestReview({ namespaceId, repositoryId, principal, requestId, ...version.parse(body) }));
    } else {
      const input = edit.parse(body);
      sendJson(response, 200, await service.mutate({ namespaceId, repositoryId, principal, requestId,
        expectedVersion: input.expectedVersion,
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.body === undefined ? {} : { body: input.body }),
        ...(input.state === undefined ? {} : { state: input.state }) }));
    }
  } catch (error) {
    if (error instanceof RepositoryAccessError) sendJson(response, error.status, { error: error.message });
    else if (error instanceof PullRequestNotFoundError) sendJson(response, 404, { error: error.message });
    else if (error instanceof PullRequestConflict || error instanceof PullRequestReviewUnavailableError) sendJson(response, 409, { error: error.message });
    else if (error instanceof z.ZodError || error instanceof NativeGitBundleHttpError) sendJson(response, 400, { error: "Invalid pull request input" });
    else throw error;
  }
  return true;
}

async function principalScope(context: RepositoryExtensionContext, request: IncomingMessage, selector: { readonly namespaceId: string; readonly repositoryId: string }): Promise<RepositoryPrincipalScope> {
  const access = repositoryAccessProvider(context.extensions);
  const initial = await access.authorize(context, request, { projectId: selector.namespaceId, repositoryId: selector.repositoryId });
  return {
    principalId: initial.actorId,
    async authorize(target) {
      const current = await access.authorize(context, request, {
        projectId: selector.namespaceId,
        repositoryId: selector.repositoryId,
        protectedRef: target.head.protectedRef,
      });
      if (current.actorId !== initial.actorId) throw new RepositoryAccessError(403, "repository principal changed during request");
    },
  };
}

function refWriter(context: RepositoryExtensionContext): PullRequestRefWriter {
  return {
    async ensure(input) {
      const git = { ...context.runtime, repository: input.access.target.repositoryPath, signal: input.signal };
      const existing = (await gitBytes(git, ["for-each-ref", "--format=%(objectname)", input.ref])).toString("ascii").trim();
      if (existing === input.commit) return;
      if (existing !== "") throw new PullRequestConflict("Pull request pin conflicts with its durable record");
      await gitBytes(git, ["-c", "core.fsync=all", "update-ref", input.ref, input.commit, "0".repeat(input.commit.length)]);
    },
  };
}

function required(service: PullRequestService | undefined): PullRequestService {
  if (service === undefined) throw new PullRequestReviewUnavailableError("Pull request service unavailable");
  return service;
}

function optionalReviewService(context: RepositoryExtensionContext): {
  createInTransaction(access: BorrowedRepositoryMutationAccess, request: ReviewRequest): Promise<ReviewEnvelope>;
} | undefined {
  const entry = context.extensions.find((candidate) => candidate.kind === "dim.code-review.service" && candidate.name === "default");
  if (entry === undefined || !("gs" in entry.value) || typeof entry.value.gs !== "function") return undefined;
  const runtime: unknown = entry.value.gs(context);
  if (!isReviewRuntime(runtime)) return undefined;
  return {
    createInTransaction: (_access, request) => runtime.adapter.withBorrowedMutation(request,
      (reviewAccess) => runtime.service.createInTransaction(reviewAccess, request)),
  };
}

function isReviewRuntime(value: unknown): value is {
  readonly adapter: { withBorrowedMutation<Result>(selector: ReviewRequest, operation: (access: BorrowedRepositoryMutationAccess) => Promise<Result>): Promise<Result> };
  readonly service: { createInTransaction(access: BorrowedRepositoryMutationAccess, request: ReviewRequest): Promise<ReviewEnvelope> };
} {
  return typeof value === "object" && value !== null && "adapter" in value
    && typeof value.adapter === "object" && value.adapter !== null
    && "withBorrowedMutation" in value.adapter && typeof value.adapter.withBorrowedMutation === "function"
    && "service" in value
    && typeof value.service === "object" && value.service !== null
    && "createInTransaction" in value.service && typeof value.service.createInTransaction === "function";
}

export { PullRequestStore } from "@slop-lab/gs-pull-request-service";
