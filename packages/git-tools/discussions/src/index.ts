import { z } from "zod";

const identitySchema = z.string().min(1).max(256).refine((value) => !value.includes("\0"));

export const discussionAnchorSchema = z.object({
  path: z.string().min(1).max(4096).refine((path) =>
    !path.includes("\0") && !path.startsWith("/") && !path.split("/").includes("..")),
  side: z.enum(["base", "head"]),
  line: z.number().int().positive(),
}).strict().readonly();

export const discussionCommentSchema = z.object({
  id: identitySchema,
  revisionId: identitySchema,
  actorId: z.string().min(1),
  body: z.string().trim().min(1).max(3000),
  createdAt: z.string().datetime(),
  anchor: discussionAnchorSchema.optional(),
}).strict().readonly();

export const discussionListSchema = z.array(discussionCommentSchema).max(10_000)
  .refine((items) => new Set(items.map((item) => item.id)).size === items.length)
  .readonly();

export type DiscussionAnchor = z.infer<typeof discussionAnchorSchema>;
export type DiscussionComment = z.infer<typeof discussionCommentSchema>;

export function parseDiscussionAnchor(value: unknown): DiscussionAnchor {
  return discussionAnchorSchema.parse(value);
}

export function parseDiscussionComment(value: unknown): DiscussionComment {
  return discussionCommentSchema.parse(value);
}

export function parseDiscussionList(value: unknown): readonly DiscussionComment[] {
  return discussionListSchema.parse(value);
}

export function appendDiscussionComment(
  comments: readonly DiscussionComment[],
  comment: DiscussionComment,
): readonly DiscussionComment[] {
  return discussionListSchema.parse([...comments, comment]);
}

export function commentIsOutdated(comment: DiscussionComment, currentRevisionId: string): boolean {
  return comment.revisionId !== currentRevisionId;
}
