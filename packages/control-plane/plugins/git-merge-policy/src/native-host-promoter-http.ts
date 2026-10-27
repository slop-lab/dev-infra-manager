import { prepareBranchMerge } from "./prepare-branch-merge.js";
import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { exactActivationIsBound, readBoundedJson, sendJson, readNativeProjectRegistrations, type RepositoryExtensionContext } from "@slop-lab/dim-control-plane-plugin-git-repositories/plugin-api";
import type { NativeInstalledPromotionResult } from "./native-installed-promotion.js";
export type HostPromoter = { readonly hostId: string; readonly username: string; readonly password: string };
export function createNativeHostPromoterService(input: {
  readonly promoters: readonly HostPromoter[];
  readonly context: RepositoryExtensionContext;
  readonly promote: (projectId: string, repositoryId: string, reviewId: string) => Promise<NativeInstalledPromotionResult>;
}) {
  return { async handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
    const identity = request.method === "GET" && url.pathname === "/v1/host-promoter-identity" && !url.search;
    const match = request.method === "POST" && !url.search ? /^\/v1\/projects\/([a-z0-9][a-z0-9-]{0,63})\/repositories\/([a-z0-9][a-z0-9-]{0,63})\/reviews\/([0-9a-f]{64})\/promotions$/.exec(url.pathname) : null;
    const merge = request.method === "POST" && !url.search ? /^\/v1\/projects\/([a-z0-9][a-z0-9-]{0,63})\/repositories\/([a-z0-9][a-z0-9-]{0,63})\/merges$/.exec(url.pathname) : null;
    if (!identity && !match && !merge) return false;
    const supplied = Buffer.from(request.headers.authorization ?? "");
    const promoter = input.promoters.find(({ username, password }) => {
      const expected = Buffer.from(`Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`);
      return supplied.length === expected.length && timingSafeEqual(supplied, expected);
    });
    if (!promoter) {
      const known = input.context.knownCredentials.some(({ username, password }) => {
        const expected = Buffer.from(`Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`);
        return supplied.length === expected.length && timingSafeEqual(supplied, expected);
      });
      sendJson(response, known ? 403 : 401, { error: known ? "forbidden" : "unauthorized" }); return true;
    }
    if (identity) { sendJson(response, 200, { schemaVersion: 1, serviceId: "native-main", role: "host-promoter", hostId: promoter.hostId, generationId: input.context.runtime.expectedGenerationId }); return true; }
    const route = match ?? merge!;
    const projectId = route[1]!, repositoryId = route[2]!, reviewId = match?.[3];
    if (!readNativeProjectRegistrations(input.context.runtime.state).some((entry) => entry.projectId === projectId && entry.repositoryId === repositoryId && entry.ownerHostId === promoter.hostId)) { sendJson(response, 404, { error: "not found" }); return true; }
    if (request.headers["x-dim-generation-id"] !== input.context.runtime.expectedGenerationId) { sendJson(response, 409, { error: "promoter generation conflicts with service startup" }); return true; }
    if (!input.context.available() || !input.context.runtime.activated()) { sendJson(response, 503, { error: "protected promotion is unavailable" }); return true; }
    try {
      if (merge) {
        const body = z.object({ schemaVersion: z.literal(1), sourceRef: z.string().startsWith("refs/heads/").max(1024), targetRef: z.string().startsWith("refs/heads/").max(1024) }).strict().parse(await readBoundedJson(request));
        const prepared = await input.context.mutate({ projectId, repositoryId }, async () => {
          if (!input.context.available() || !input.context.runtime.activated() || !exactActivationIsBound(input.context.runtime.state, input.context.runtime.expectedGenerationId, input.context.runtime.activationTokenDigest)) throw new Error("branch merge requires exact generation activation");
          if (!readNativeProjectRegistrations(input.context.runtime.state).some((entry) => entry.projectId === projectId && entry.repositoryId === repositoryId && entry.ownerHostId === promoter.hostId)) throw new Error("repository ownership changed");
          return prepareBranchMerge(input.context, { projectId, repositoryId, sourceRef: body.sourceRef, targetRef: body.targetRef });
        });
        sendJson(response, 200, prepared); return true;
      }
      z.object({ schemaVersion: z.literal(1) }).strict().parse(await readBoundedJson(request));
      const promoted = await input.promote(projectId, repositoryId, reviewId!);
      sendJson(response, promoted.outcome === "promoted" ? 201 : 200, promoted);
    } catch (error) { sendJson(response, 409, { error: error instanceof Error ? error.message : "promotion rejected" }); }
    return true;
  } };
}
