import { parseGitReview, type GitReview } from "@slop-lab/gs-client";
import { z } from "zod";

export type ReviewDto = Omit<GitReview, "namespaceId"> & { readonly projectId: string };

export function reviewDto(input: unknown): ReviewDto {
  const row = z.record(z.string(), z.unknown()).parse(input);
  const mapped = mapReviewNamespace(row);
  const review = parseGitReview(mapped);
  const { namespaceId, ...rest } = review;
  return { ...rest, projectId: namespaceId };
}

export function mapReviewNamespace(input: unknown): unknown {
  const row = z.record(z.string(), z.unknown()).parse(input);
  if (row.schemaVersion === 3) {
    const review = z.record(z.string(), z.unknown()).parse(row.review);
    return { ...row, review: projectToNamespace(review) };
  }
  return projectToNamespace(row);
}

function projectToNamespace(review: Record<string, unknown>): Record<string, unknown> {
  if (typeof review.namespaceId === "string") return review;
  const projectId = z.string().parse(review.projectId);
  const { projectId: _projectId, ...rest } = review;
  return { ...rest, namespaceId: projectId };
}
