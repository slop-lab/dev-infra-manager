import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { approveExactReview, revokeExactApproval } from "./native-human-reviewer-decisions.js";
import type {
  Credential,
  ExactReviewRoute,
  HumanReviewerHttpInput,
  HumanReviewerRequestContext,
  NativeHumanReviewerService,
  RepositoryReviewRoute
} from "./native-human-reviewer-http-types.js";
import { listReviewSummaries, serveExactReview } from "./native-human-reviewer-read.js";
import { resolveCurrentEnvelope } from "./native-human-reviewer-resolution.js";
import { sendJson } from "@slop-lab/dim-control-plane-plugin-git-repositories/plugin-api";

export type { NativeHumanReviewerHooks, NativeHumanReviewerService } from "./native-human-reviewer-http-types.js";

const repositoryReviewsPattern = /^\/v1\/projects\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\/repositories\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\/reviews$/;
const resolveReviewPattern = /^\/v1\/projects\/[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?\/repositories\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\/reviews\/resolve$/;
const exactReviewPattern = /^\/v1\/projects\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\/repositories\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\/reviews\/([0-9a-f]{64})(\/(?:approvals|revocations))?$/;

export function createNativeHumanReviewerService(input: HumanReviewerHttpInput): NativeHumanReviewerService {
  return {
    async handle(request, response, url) {
      const identity = request.method === "GET" && url.pathname === "/v1/human-reviewer-identity"
        && url.search === "";
      const listing = request.method === "GET" && url.search === ""
        ? repositoryReviewsPattern.exec(url.pathname)
        : null;
      const resolve = request.method === "POST" && url.search === "" && resolveReviewPattern.test(url.pathname);
      const match = exactReviewPattern.exec(url.pathname);
      const review = request.method === "GET" && url.search === "" && match !== null && match[4] === undefined;
      const approval = request.method === "POST" && url.search === "" && match?.[4] === "/approvals";
      const revocation = request.method === "POST" && url.search === "" && match?.[4] === "/revocations";
      if (!identity && listing === null && !resolve && !review && !approval && !revocation) return false;
      const reviewer = input.config.humanReviewers.find((candidate) => basicAuthorized(request, candidate));
      if (reviewer === undefined) {
        const known = input.knownCredentials.some((credential) => basicAuthorized(request, credential));
        sendJson(response, known ? 403 : 401, { error: known ? "forbidden" : "unauthorized" });
        return true;
      }
      if (identity) {
        sendJson(response, 200, {
          schemaVersion: 1,
          serviceId: "native-main",
          role: "human-reviewer",
          reviewerId: reviewer.reviewerId,
          ...((input.features?.length ?? 0) === 0 ? {} : { features: input.features }),
          generationId: input.runtime.expectedGenerationId
        });
        return true;
      }
      const context: HumanReviewerRequestContext = { input, reviewer, request, response };
      const listingRoute = repositoryRoute(listing);
      if (listingRoute !== undefined) {
        await listReviewSummaries(context, listingRoute);
        return true;
      }
      if (resolve) {
        const projectId = url.pathname.split("/")[3];
        const repositoryId = url.pathname.split("/")[5];
        if (projectId === undefined || repositoryId === undefined) return false;
        await resolveCurrentEnvelope(context, { projectId, repositoryId });
        return true;
      }
      const route = exactReviewRoute(match);
      if (route === undefined) return false;
      if (approval) await approveExactReview(context, route);
      else if (revocation) await revokeExactApproval(context, route);
      else await serveExactReview(context, route);
      return true;
    }
  };
}

function repositoryRoute(match: RegExpExecArray | null): RepositoryReviewRoute | undefined {
  const projectId = match?.[1];
  const repositoryId = match?.[2];
  return projectId === undefined || repositoryId === undefined ? undefined : { projectId, repositoryId };
}

function exactReviewRoute(match: RegExpExecArray | null): ExactReviewRoute | undefined {
  const repository = repositoryRoute(match);
  const reviewId = match?.[3];
  return repository === undefined || reviewId === undefined ? undefined : { ...repository, reviewId };
}

function basicAuthorized(request: IncomingMessage, credential: Credential): boolean {
  const supplied = Buffer.from(request.headers.authorization ?? "");
  const expected = Buffer.from(`Basic ${Buffer.from(
    `${credential.username}:${credential.password}`,
    "utf8"
  ).toString("base64")}`);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
