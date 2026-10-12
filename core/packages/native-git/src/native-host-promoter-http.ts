import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { AuthoritativeNativeReviewEnvelope } from "./authoritative-native-review-schema.js";
import type { AuthoritativeNativeCandidateRuntime } from "./authoritative-native-root-target.js";
import type { NativeGitBundleConfig } from "./bundle-config.js";
import { exactActivationIsBound } from "./native-bundle-activation.js";
import { NativeGitBundleHttpError, readBoundedJson, sendJson, sendNotFound } from "./native-bundle-http.js";
import { readNativeProjectRegistrations } from "./native-bundle-state.js";
import type { NativeInstalledPromotionResult } from "./native-installed-promotion.js";

type Credential = { readonly username: string; readonly password: string };
type Promoter = NativeGitBundleConfig["hostPromoters"][number];
type Input = {
  readonly config: NativeGitBundleConfig;
  readonly knownCredentials: readonly Credential[];
  readonly runtime: AuthoritativeNativeCandidateRuntime;
  readonly createReview: (input: { readonly projectId: string; readonly repositoryId: "root";
    readonly proposalRef: string }) => Promise<AuthoritativeNativeReviewEnvelope>;
  readonly promote: (projectId: string, reviewId: string) => Promise<NativeInstalledPromotionResult>;
};

const createSchema = z.object({ schemaVersion: z.literal(1), proposalRef: z.string().min(1).max(1024) })
  .strict().readonly();
const promoteSchema = z.object({ schemaVersion: z.literal(1) }).strict().readonly();
const reviewRoute = /^\/v1\/projects\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\/repositories\/root\/reviews$/;
const promotionRoute = /^\/v1\/projects\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\/repositories\/root\/reviews\/([0-9a-f]{64})\/promotions$/;

export type NativeHostPromoterService = {
  readonly handle: (request: IncomingMessage, response: ServerResponse, url: URL) => Promise<boolean>;
};

export function createNativeHostPromoterService(input: Input): NativeHostPromoterService {
  return { async handle(request, response, url) {
    const identity = request.method === "GET" && url.pathname === "/v1/host-promoter-identity" && url.search === "";
    const createMatch = request.method === "POST" && url.search === "" ? reviewRoute.exec(url.pathname) : null;
    const promoteMatch = request.method === "POST" && url.search === "" ? promotionRoute.exec(url.pathname) : null;
    if (!identity && createMatch === null && promoteMatch === null) return false;
    const promoter = input.config.hostPromoters.find((candidate) => basicAuthorized(request, candidate));
    if (promoter === undefined) {
      const known = input.knownCredentials.some((credential) => basicAuthorized(request, credential));
      sendJson(response, known ? 403 : 401, { error: known ? "forbidden" : "unauthorized" });
      return true;
    }
    if (identity) {
      sendJson(response, 200, { schemaVersion: 1, serviceId: "native-main", role: "host-promoter",
        hostId: promoter.hostId, generationId: input.runtime.expectedGenerationId });
      return true;
    }
    const projectId = createMatch?.[1] ?? promoteMatch?.[1];
    if (projectId === undefined || !authorizedProject(input, promoter, projectId)) {
      sendNotFound(response);
      return true;
    }
    if (request.headers["x-dim-generation-id"] !== input.runtime.expectedGenerationId) {
      sendJson(response, 409, { error: "promoter generation conflicts with service startup" });
      return true;
    }
    if (!input.runtime.activated() || !exactActivationIsBound(input.runtime.state,
      input.runtime.expectedGenerationId, input.runtime.activationTokenDigest)) {
      sendJson(response, 503, { error: "protected promotion is unavailable" });
      return true;
    }
    try {
      if (createMatch !== null) {
        const body = createSchema.parse(await readBoundedJson(request));
        const envelope = await input.createReview({ projectId, repositoryId: "root", proposalRef: body.proposalRef });
        sendJson(response, 201, envelope);
      } else {
        promoteSchema.parse(await readBoundedJson(request));
        const reviewId = promoteMatch?.[2];
        if (reviewId === undefined) return true;
        const promoted = await input.promote(projectId, reviewId);
        sendJson(response, promoted.outcome === "promoted" ? 201 : 200, promoted);
      }
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof NativeGitBundleHttpError) {
        sendJson(response, 400, { error: "promoter request is invalid" });
      } else if (error instanceof Error) {
        sendJson(response, 409, { error: error.message });
      } else throw error;
    }
    return true;
  } };
}

function authorizedProject(input: Input, promoter: Promoter, projectId: string): boolean {
  return readNativeProjectRegistrations(input.runtime.state)
    .some((entry) => entry.projectId === projectId && entry.ownerHostId === promoter.hostId);
}

function basicAuthorized(request: IncomingMessage, credential: Credential): boolean {
  const supplied = Buffer.from(request.headers.authorization ?? "");
  const expected = Buffer.from(`Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString("base64")}`);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
