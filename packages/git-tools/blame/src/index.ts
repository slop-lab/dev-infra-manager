import { z } from "zod";

const objectIdSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const repositoryPathSchema = z.string().min(1).max(4096).refine((path) =>
  !path.includes("\0")
  && !path.includes("\n")
  && !path.startsWith("/")
  && path.split("/").every((part) => part !== ".." && part !== "." && part !== ""));

export const gitBlameRequestSchema = z.object({
  commit: objectIdSchema,
  path: repositoryPathSchema,
  line: z.number().int().min(1).max(10_000_000),
}).strict().readonly();

export const gitLineAttributionSchema = z.object({
  commit: objectIdSchema,
  path: repositoryPathSchema,
  line: z.number().int().min(1).max(10_000_000),
  author: z.string().max(4096),
  summary: z.string().max(65_536),
}).strict().readonly();

export type GitBlameRequest = z.infer<typeof gitBlameRequestSchema>;
export type GitLineAttribution = z.infer<typeof gitLineAttributionSchema>;

export class GitBlameParseError extends Error {
  override name = "GitBlameParseError";
}

export function parseGitBlameRequest(value: unknown): GitBlameRequest {
  return gitBlameRequestSchema.parse(value);
}

export function parseGitLineAttribution(value: unknown): GitLineAttribution {
  return gitLineAttributionSchema.parse(value);
}

export function parseLinePorcelain(output: string, request: GitBlameRequest): GitLineAttribution {
  if (new TextEncoder().encode(output).byteLength > 256 * 1024) {
    throw new GitBlameParseError("Git line attribution exceeds its limit");
  }
  const rows = output.split("\n");
  const match = /^([a-f0-9]{40}|[a-f0-9]{64}) \d+ \d+(?: \d+)?$/.exec(rows[0] ?? "");
  const author = rows.find((row) => row.startsWith("author "))?.slice(7);
  const summary = rows.find((row) => row.startsWith("summary "))?.slice(8);
  if (match?.[1] === undefined || author === undefined || summary === undefined) {
    throw new GitBlameParseError("Git line attribution is invalid");
  }
  return gitLineAttributionSchema.parse({
    commit: match[1],
    path: request.path,
    line: request.line,
    author,
    summary,
  });
}
