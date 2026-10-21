import { isAbsolute } from "node:path";
import { z } from "zod";
import { loadPrivateJson, type WebPlugin } from "@slop-lab/dim-web/plugin-api";
import type { Operation } from "@slop-lab/dim-contracts-operations";
import { NativeGitClient } from "./client.js";
import { createSyncClient, syncResultSchema } from "./sync.js";
import { reviewDto } from "./dto.js";

const identifier = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/);
const origin = z.string().url().refine((value) => {
  const u = new URL(value);
  return u.origin === value && !u.username && !u.password && (u.protocol === "https:" || u.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(u.hostname));
});
const connection = z.object({ schemaVersion: z.literal(1), serviceId: z.literal("native-main"), baseUrl: origin,
  generationId: z.string().regex(/^[a-f0-9]{64}$/), reviewerId: identifier, username: z.string().min(1).max(256), password: z.string().min(16).max(1024) }).strict();
const promoterConnection = z.object({ schemaVersion: z.literal(1), serviceId: z.literal("native-main"), endpoint: origin, role: z.literal("host-promoter"),
  generationId: z.string().regex(/^[a-f0-9]{64}$/), hostId: identifier, credential: z.object({ username: z.string().min(1).max(256), password: z.string().min(16).max(1024) }).strict() }).strict();
const file = z.string().refine(isAbsolute);
const configSchema = z.object({ reviewerConnection: file, promoterConnection: file.optional(), syncConnection: file.optional(), projectId: identifier,
  repositoryIds: z.array(identifier).min(1).max(64).refine((ids) => new Set(ids).size === ids.length) }).strict();
const scope = z.object({ repositoryId: identifier }).strict();
const review = scope.extend({ reviewId: z.string().regex(/^[a-f0-9]{64}$/) });
const reviewResult = (value: unknown) => {
  // Reuse the same strict public projection as the service evidence decoder.
  const row = z.record(z.string(), z.unknown()).parse(value);
  return reviewDto({ schemaVersion: 3, review: row, status: row.status, staleReasons: row.staleReasons, approvals: row.approvals, revocations: row.revocations });
};
const summaries = z.array(z.object({ reviewId: z.string().regex(/^[a-f0-9]{64}$/), proposalRef: z.string().max(1024), protectedRef: z.string().max(1024),
  candidateCommit: z.string().regex(/^[a-f0-9]{40,64}$/), createdAt: z.string().datetime(), status: z.string().max(64) }).strict()).max(100);
const promotion = z.object({ schemaVersion: z.literal(1), outcome: z.enum(["promoted", "already-current"]), reviewId: z.string(),
  protectedRef: z.string(), expectedProtectedHead: z.string(), candidateCommit: z.string(), candidateTree: z.string() }).strict();
export const operations: readonly Operation[] = [
  ...(["fetch", "merge", "publish"] as const).map((action): Operation => ({ name: `sync.${action}`, description: action === "fetch" ? "Fetch upstream refs" : action === "merge" ? "Propose upstream merge for protected review" : "Publish protected head upstream", access: "operator", parseInput: (v: unknown) => scope.parse(v), parseOutput: (v: unknown) => syncResultSchema.parse(v) })),
  { name: "repositories.list", description: "List configured project repositories", access: "read", parseInput: (v) => z.object({}).strict().default({}).parse(v), parseOutput: (v) => z.object({ projectId: identifier, repositoryIds: z.array(identifier), reviewerId: identifier }).strict().parse(v) },
  { name: "reviews.list", description: "List repository reviews", access: "read", parseInput: (v) => scope.parse(v), parseOutput: (v) => summaries.parse(v) },
  { name: "reviews.detail", description: "Read review evidence and patch", access: "read", parseInput: (v) => review.parse(v), parseOutput: reviewResult },
  { name: "reviews.resolve", description: "Create or resolve review from proposal ref", access: "reviewer", parseInput: (v) => scope.extend({ proposalRef: z.string().startsWith("refs/").max(1024) }).parse(v), parseOutput: reviewResult },
  { name: "reviews.approve", description: "Approve this exact review", access: "reviewer", parseInput: (v) => review.parse(v), parseOutput: reviewResult },
  { name: "reviews.revoke", description: "Revoke an approval", access: "reviewer", parseInput: (v) => review.extend({ approvalId: z.string().regex(/^[a-f0-9]{64}$/) }).parse(v), parseOutput: reviewResult },
  { name: "reviews.promote", description: "Promote approved candidate to protected ref", access: "operator", parseInput: (v) => review.parse(v), parseOutput: (v) => promotion.parse(v) }
];
export const webPlugin: WebPlugin = {
  id: "native-git", title: "Git review", description: "Repository proposals, review evidence and protected promotion", operations,
  assets: { "panel.js": new URL("./assets/panel.js", import.meta.url) }, browserEntry: "panel.js",
  async create(input) {
    const config = configSchema.parse(input);
    const reviewer = connection.parse(await loadPrivateJson(config.reviewerConnection));
    const promoter = config.promoterConnection ? promoterConnection.parse(await loadPrivateJson(config.promoterConnection)) : undefined;
    if (promoter && (promoter.endpoint !== reviewer.baseUrl || promoter.generationId !== reviewer.generationId)) throw new Error("Native Git promoter and reviewer connections must select the same service generation");
    const client = new NativeGitClient({ ...reviewer, ...(promoter ? { promoter: { ...promoter.credential, hostId: promoter.hostId } } : {}) });
    await client.attest();
    const sync = config.syncConnection ? await createSyncClient(config.syncConnection, { baseUrl: reviewer.baseUrl, generationId: reviewer.generationId, ...(promoter ? { hostId: promoter.hostId } : {}) }) : undefined;
    return {
      operations: operations.filter((operation) => (promoter || operation.name !== "reviews.promote") && (sync || !operation.name.startsWith("sync."))),
      async invoke(name, input) {
        if (name === "repositories.list") return { projectId: config.projectId, repositoryIds: config.repositoryIds, reviewerId: reviewer.reviewerId };
        const selected = scope.passthrough().parse(input);
        if (!config.repositoryIds.includes(selected.repositoryId)) throw new Error("Repository is outside this Web plugin's configured scope");
        const project = config.projectId, repository = selected.repositoryId;
        if (name === "sync.fetch" || name === "sync.merge" || name === "sync.publish") {
          if (!sync) throw new Error("Git sync operator connection is not configured");
          return sync.invoke(project, repository, name === "sync.fetch" ? "fetch" : name === "sync.merge" ? "merge" : "publish");
        }
        if (name === "reviews.list") return client.listReviews(project, repository);
        if (name === "reviews.resolve") return client.resolveReview(project, repository, scope.extend({ proposalRef: z.string().startsWith("refs/").max(1024) }).parse(input));
        const target = review.passthrough().parse(input);
        if (name === "reviews.detail") return client.getReview(project, repository, target.reviewId);
        if (name === "reviews.approve") return client.approveReview(project, repository, target.reviewId);
        if (name === "reviews.revoke") return client.revokeApproval(project, repository, target.reviewId, review.extend({ approvalId: z.string().regex(/^[a-f0-9]{64}$/) }).parse(input).approvalId);
        if (name === "reviews.promote") return client.promote(project, repository, target.reviewId);
        throw new Error("Unknown Native Git operation");
      }
    };
  }
};
