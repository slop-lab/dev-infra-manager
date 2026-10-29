import {
  GitServiceClient,
  commentPullRequestInputSchema,
  createPullRequestInputSchema,
  createGitServiceClient,
  diffInputSchema,
  reviewSelectionSchema,
  updatePullRequestInputSchema,
  type GitClientCapability,
  type PromotionReceipt,
  type PullRequestWorkflowInput,
} from "@slop-lab/gs-client";
import { z } from "zod";
import { reviewDto, type ReviewDto } from "./dto.js";
import { NativeGitClientError, NativeGitHttpError, NativeGitJsonTransport } from "./native-transport.js";

export type NativeConfig = {
  readonly baseUrl: string;
  readonly generationId: string;
  readonly reviewerId: string;
  readonly username: string;
  readonly password: string;
  readonly promoter?: { readonly hostId: string; readonly username: string; readonly password: string };
};

const identitySchema = z.object({
  schemaVersion: z.literal(1),
  serviceId: z.literal("native-main"),
  role: z.literal("human-reviewer"),
  reviewerId: z.string(),
  generationId: z.string().regex(/^[0-9a-f]{64}$/),
  features: z.array(z.string().max(128)).max(64).optional(),
}).strict();
const featureCapabilities = new Map<string, GitClientCapability>([
  ["git-diff", "git-diff"],
  ["git-blame", "git-blame"],
  ["git-ci", "git-ci"],
  ["git-discussions", "git-discussions"],
  ["git-pull-requests", "git-pull-requests"],
]);

export class NativeGitClient {
  private readonly transport: NativeGitJsonTransport;
  private portable: GitServiceClient | undefined;
  private availableFeatures: readonly string[] = [];

  constructor(private readonly config: NativeConfig) {
    this.transport = new NativeGitJsonTransport({
      baseUrl: config.baseUrl,
      reviewer: { username: config.username, password: config.password },
      ...(config.promoter === undefined ? {} : { promoter: { username: config.promoter.username, password: config.promoter.password } }),
    });
  }

  get features(): readonly string[] {
    return this.availableFeatures;
  }

  async attest(): Promise<void> {
    const identity = identitySchema.parse(await this.transport.requestIdentity("/v1/human-reviewer-identity"));
    if (identity.reviewerId !== this.config.reviewerId || identity.generationId !== this.config.generationId) {
      throw new NativeGitClientError("native Git human reviewer identity or control-plane generation does not match connection");
    }
    if (this.config.promoter !== undefined) {
      const promoter = z.object({ schemaVersion: z.literal(1), serviceId: z.literal("native-main"), role: z.literal("host-promoter"), hostId: z.string(), generationId: z.string() }).strict()
        .parse(await this.transport.requestIdentity("/v1/host-promoter-identity", "promoter"));
      if (promoter.generationId !== identity.generationId || promoter.hostId !== this.config.promoter.hostId) {
        throw new NativeGitClientError("promoter identity or generation conflicts");
      }
    }
    this.transport.setGeneration(identity.generationId);
    this.availableFeatures = identity.features ?? [];
    const capabilities: GitClientCapability[] = ["git-review"];
    for (const feature of this.availableFeatures) {
      const capability = featureCapabilities.get(feature);
      if (capability !== undefined) capabilities.push(capability);
    }
    if (this.config.promoter !== undefined) capabilities.push("git-merge");
    this.portable = createGitServiceClient({ transport: this.transport, capabilities });
  }

  async invokeRepositoryFeature(name: string, input: Record<string, unknown>): Promise<unknown> {
    const client = this.client();
    const portable = projectInput(input);
    switch (name) {
      case "diff.read": return client.readDiff(diffInputSchema.parse(portable));
      case "blame.line": return client.blameLine(z.object({ namespaceId: z.string(), repositoryId: z.string(), commit: z.string(), path: z.string(), line: z.number() }).parse(portable));
      case "ci.status": return client.readCiStatus(reviewSelectionSchema.parse(portable));
      case "pull-requests.list": return client.listPullRequests(portable);
      case "pull-requests.create": return client.createPullRequest(createPullRequestInputSchema.parse(portable));
      case "pull-requests.detail": return client.readPullRequest(portable, z.string().parse(input.pullRequestId));
      case "pull-requests.update": return client.updatePullRequest(updatePullRequestInputSchema.parse(portable));
      case "pull-requests.refresh": return client.refreshPullRequest(z.object({ namespaceId: z.string(), repositoryId: z.string(), pullRequestId: z.string(), expectedVersion: z.number() }).parse(portable));
      case "pull-requests.comment": return client.commentPullRequest(commentPullRequestInputSchema.parse(portable));
      case "pull-requests.review": return client.preparePullRequestReview(z.object({ namespaceId: z.string(), repositoryId: z.string(), pullRequestId: z.string(), expectedVersion: z.number() }).parse(portable));
      default: throw new NativeGitClientError("Unknown Git repository operation");
    }
  }

  async listReviews(projectId: string, repositoryId: string): Promise<unknown> {
    return this.client().listReviews({ namespaceId: projectId, repositoryId });
  }

  async prepareMerge(projectId: string, repositoryId: string, input: { readonly sourceRef: string; readonly targetRef: string }): Promise<unknown> {
    return this.client().prepareMerge({ namespaceId: projectId, repositoryId, ...input });
  }

  async promote(projectId: string, repositoryId: string, reviewId: string): Promise<PromotionReceipt> {
    return this.client().promote({ namespaceId: projectId, repositoryId, reviewId });
  }

  async getReview(projectId: string, repositoryId: string, reviewId: string): Promise<ReviewDto> {
    return portableReview(await this.client().getReview({ namespaceId: projectId, repositoryId, reviewId }));
  }

  async resolveReview(projectId: string, repositoryId: string, input: { readonly proposalRef: string; readonly protectedRef?: string }): Promise<ReviewDto> {
    return portableReview(await this.client().resolveReview({ namespaceId: projectId, repositoryId, ...input }));
  }

  async approveReview(projectId: string, repositoryId: string, reviewId: string): Promise<ReviewDto> {
    return portableReview(await this.client().approveReview({ namespaceId: projectId, repositoryId }, reviewId));
  }

  async revokeApproval(projectId: string, repositoryId: string, reviewId: string, approvalId: string): Promise<ReviewDto> {
    return portableReview(await this.client().revokeReview({ namespaceId: projectId, repositoryId }, reviewId, approvalId));
  }

  async invokePullRequestWorkflow(name: "pull-requests.approve" | "pull-requests.revoke" | "pull-requests.merge", input: Omit<PullRequestWorkflowInput, "namespaceId"> & { readonly projectId: string }): Promise<unknown> {
    const client = this.client();
    const { projectId, ...selection } = input;
    const portableInput = { ...selection, namespaceId: projectId };
    if (name === "pull-requests.approve") return portableReview(await client.approvePullRequest(portableInput));
    if (name === "pull-requests.revoke") return portableReview(await client.revokePullRequest(portableInput, this.config.reviewerId));
    const merged = await client.mergePullRequest(portableInput);
    return { ...merged, review: portableReview(merged.review) };
  }

  private client(): GitServiceClient {
    if (this.portable === undefined) throw new NativeGitClientError("native Git client identity has not been attested");
    return this.portable;
  }
}

function projectInput(input: Record<string, unknown>): Record<string, unknown> & { readonly namespaceId: string; readonly repositoryId: string } {
  const { projectId, repositoryId, ...rest } = input;
  return { ...rest, namespaceId: z.string().parse(projectId), repositoryId: z.string().parse(repositoryId) };
}

function portableReview(review: { readonly namespaceId: string } & Record<string, unknown>): ReviewDto {
  return reviewDto(review);
}

export { NativeGitClientError, NativeGitHttpError } from "./native-transport.js";
