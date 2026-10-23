import { repositoryFeature, repositoryFeatureOperations } from "./repository-features.js";
import { z } from "zod";
import type { Operation } from "@slop-lab/dim-contracts-operations";
import { NativeGitClient, preparedBranchMergeSchema } from "./client.js";
import { createSyncClient, syncResultSchema } from "./sync.js";
import { reviewDto } from "./dto.js";
import { loadPrivateJson } from "./private-file.js";
const identifier = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/);
const actor = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/);
const origin = z.string().url().refine((value) => { const u = new URL(value); return u.origin === value && !u.username && !u.password && (u.protocol === "https:" || u.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(u.hostname)); });
export const reviewerConnectionSchema = z.object({ schemaVersion: z.literal(1), serviceId: z.literal("native-main"), baseUrl: origin, generationId: z.string().regex(/^[a-f0-9]{64}$/), reviewerId: identifier, username: z.string().min(1).max(256), password: z.string().min(16).max(1024) }).strict();
export const promoterConnectionSchema = z.object({ schemaVersion: z.literal(1), serviceId: z.literal("native-main"), endpoint: origin, role: z.literal("host-promoter"), generationId: z.string().regex(/^[a-f0-9]{64}$/), hostId: actor, credential: z.object({ username: z.string().min(1).max(256), password: z.string().min(16).max(1024) }).strict() }).strict();
export const nativeGitProjectSchema = z.object({ projectId: identifier, name: z.string().min(1).max(128), repositoryIds: z.array(identifier).max(64).refine((ids) => new Set(ids).size === ids.length), repositories: z.array(z.object({ repositoryId: identifier, defaultRef: z.string().startsWith("refs/heads/"), branches: z.array(z.string().startsWith("refs/heads/")).max(64) }).strict()).max(64).optional() }).strict();
export type NativeGitOperatorProject = z.infer<typeof nativeGitProjectSchema>;
const projectsSchema = z.array(nativeGitProjectSchema).max(1000).refine((rows) => new Set(rows.map((row) => row.projectId)).size === rows.length);
const scope = z.object({ projectId: identifier, repositoryId: identifier }).strict();
const review = scope.extend({ reviewId: z.string().regex(/^[a-f0-9]{64}$/) });
const reviewResult = (value: unknown) => { const row = z.record(z.string(), z.unknown()).parse(value); return reviewDto({ schemaVersion: 3, review: row, status: row.status, staleReasons: row.staleReasons, approvals: row.approvals, revocations: row.revocations }); };
const summaries = z.array(z.object({ reviewId: z.string().regex(/^[a-f0-9]{64}$/), proposalRef: z.string().max(1024), protectedRef: z.string().max(1024), candidateCommit: z.string().regex(/^[a-f0-9]{40,64}$/), createdAt: z.string().datetime(), status: z.string().max(64) }).strict()).max(100);
const promotion = z.object({ schemaVersion: z.literal(1), outcome: z.enum(["promoted", "already-current"]), reviewId: z.string(), protectedRef: z.string(), expectedProtectedHead: z.string(), candidateCommit: z.string(), candidateTree: z.string() }).strict();
export const nativeGitOperations: readonly Operation[] = [
  ...repositoryFeatureOperations,
  { name: "projects.list", description: "List projects and ready repositories on this controller", access: "read", parseInput: (v) => z.object({}).strict().default({}).parse(v), parseOutput: (v) => z.object({ reviewerId: identifier, projects: projectsSchema }).strict().parse(v) },
  ...(["fetch", "merge", "publish"] as const).map((action): Operation => ({ name: `sync.${action}`, description: action === "fetch" ? "Fetch upstream refs" : action === "merge" ? "Propose upstream merge for protected review" : "Publish protected head upstream", access: "operator", parseInput: (v) => scope.extend({ protectedRef: z.string().startsWith("refs/heads/").max(1024).optional() }).parse(v), parseOutput: (v) => syncResultSchema.parse(v) })),
  { name: "merges.prepare", description: "Create a branch merge proposal and exact target review", access: "operator", parseInput: (v) => scope.extend({ sourceRef: z.string().startsWith("refs/heads/").max(1024), targetRef: z.string().startsWith("refs/heads/").max(1024) }).parse(v), parseOutput: (v) => preparedBranchMergeSchema.parse(v) },
  { name: "reviews.list", description: "List repository reviews", access: "read", parseInput: (v) => scope.parse(v), parseOutput: (v) => summaries.parse(v) },
  { name: "reviews.detail", description: "Read review evidence and patch", access: "read", parseInput: (v) => review.parse(v), parseOutput: reviewResult },
  { name: "reviews.resolve", description: "Create or resolve review from proposal ref", access: "reviewer", parseInput: (v) => scope.extend({ proposalRef: z.string().startsWith("refs/").max(1024), protectedRef: z.string().startsWith("refs/heads/").max(1024).optional() }).parse(v), parseOutput: reviewResult },
  { name: "reviews.approve", description: "Approve this exact review", access: "reviewer", parseInput: (v) => review.parse(v), parseOutput: reviewResult },
  { name: "reviews.revoke", description: "Revoke an approval", access: "reviewer", parseInput: (v) => review.extend({ approvalId: z.string().regex(/^[a-f0-9]{64}$/) }).parse(v), parseOutput: reviewResult },
  { name: "reviews.promote", description: "Promote approved candidate to protected ref", access: "operator", parseInput: (v) => review.parse(v), parseOutput: (v) => promotion.parse(v) }
];
export async function createNativeGitOperator(config: {
  reviewerConnection: string; promoterConnection?: string; syncConnection?: string;
  projects: () => Promise<readonly NativeGitOperatorProject[]>;
  selectedService?: { endpoint: string; generationId: string; hostId: string };
}) {
  const reviewer = reviewerConnectionSchema.parse(await loadPrivateJson(config.reviewerConnection));
  const promoter = config.promoterConnection ? promoterConnectionSchema.parse(await loadPrivateJson(config.promoterConnection)) : undefined;
  const selected = config.selectedService;
  if (selected && (reviewer.baseUrl !== selected.endpoint || reviewer.generationId !== selected.generationId)) throw new Error("Native Git reviewer connection conflicts with selected control plane");
  if (promoter && (promoter.endpoint !== reviewer.baseUrl || promoter.generationId !== reviewer.generationId || selected && promoter.hostId !== selected.hostId)) throw new Error("Native Git promoter connection conflicts with selected control plane");
  const client = new NativeGitClient({ ...reviewer, ...(promoter ? { promoter: { ...promoter.credential, hostId: promoter.hostId } } : {}) });
  await client.attest();
  const hostId = selected?.hostId ?? promoter?.hostId;
  const sync = config.syncConnection ? await createSyncClient(config.syncConnection, { baseUrl: reviewer.baseUrl, generationId: reviewer.generationId, ...(hostId ? { hostId } : {}) }) : undefined;
  const operations = nativeGitOperations.filter((operation) => (repositoryFeature(operation.name) === undefined || client.features.includes(repositoryFeature(operation.name)!)) && (promoter || !["reviews.promote", "merges.prepare"].includes(operation.name)) && (sync || !operation.name.startsWith("sync.")));
  return {
    get reviewerId() { return reviewer.reviewerId; },
    operations,
    async invoke(name: string, raw: unknown): Promise<unknown> {
      const operation = operations.find((operation) => operation.name === name);
      if (!operation) throw new Error("Native Git operation is unavailable");
      const input = operation.parseInput(raw), projects = projectsSchema.parse(await config.projects());
      if (name === "projects.list") return operation.parseOutput({ reviewerId: reviewer.reviewerId, projects });
      const { projectId, repositoryId } = scope.passthrough().parse(input);
      if (!projects.some((project) => project.projectId === projectId && project.repositoryIds.includes(repositoryId))) throw new Error("Repository is outside this controller's current project catalog");
      let result: unknown;
      if (repositoryFeature(name) !== undefined) result = await client.invokeRepositoryFeature(name, input);
      else if (name === "sync.fetch" || name === "sync.merge" || name === "sync.publish") {
        if (!sync) throw new Error("Git sync operator connection is not configured");
        result = await sync.invoke(projectId, repositoryId, name === "sync.fetch" ? "fetch" : name === "sync.merge" ? "merge" : "publish", scope.extend({ protectedRef: z.string().optional() }).parse(input).protectedRef);
      } else if (name === "merges.prepare") result = await client.prepareMerge(projectId, repositoryId, scope.extend({ sourceRef: z.string(), targetRef: z.string() }).parse(input));
      else if (name === "reviews.list") result = await client.listReviews(projectId, repositoryId);
      else if (name === "reviews.resolve") result = await client.resolveReview(projectId, repositoryId, scope.extend({ proposalRef: z.string().startsWith("refs/").max(1024), protectedRef: z.string().startsWith("refs/heads/").max(1024).optional() }).parse(input));
      else {
        const target = review.passthrough().parse(input);
        if (name === "reviews.detail") result = await client.getReview(projectId, repositoryId, target.reviewId);
        else if (name === "reviews.approve") result = await client.approveReview(projectId, repositoryId, target.reviewId);
        else if (name === "reviews.revoke") result = await client.revokeApproval(projectId, repositoryId, target.reviewId, review.extend({ approvalId: z.string().regex(/^[a-f0-9]{64}$/) }).parse(input).approvalId);
        else if (name === "reviews.promote") result = await client.promote(projectId, repositoryId, target.reviewId);
        else throw new Error("Unknown Native Git operation");
      }
      return operation.parseOutput(result);
    }
  };
}
