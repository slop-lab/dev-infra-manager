import { z } from "zod";
import { nativeRepositoryBranches } from "@slop-lab/dim-contracts-git";
import type { ControlPlanePlugin, PreparedControlPlanePlugin } from "@slop-lab/dim-control-plane-core/plugin-api";
import { repositoryReadHistoryRefs, repositoryExtension, repositoryAccessProvider, RepositoryAccessError, RepositoryReadError, readBoundedJson, sendJson, NativeGitBundleHttpError, assertAdvertisedCommits, gitBytes, readTreeFile, utf8, type RepositoryReadGit } from "@slop-lab/dim-control-plane-plugin-git-repositories/plugin-api";
export interface GitLineAttribution { readonly commit: string; readonly path: string; readonly line: number; readonly author: string; readonly summary: string }
const requestSchema = z.object({ commit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/), path: z.string().min(1).max(4096).refine((path) => !path.includes("\0") && !path.includes("\n") && !path.startsWith("/") && path.split("/").every((part) => part !== ".." && part !== "." && part !== "")), line: z.number().int().min(1).max(10_000_000) }).strict();
export async function readLineAttribution(git: RepositoryReadGit, input: z.infer<typeof requestSchema>): Promise<GitLineAttribution> {
  const body = requestSchema.parse(input);
  const file = await readTreeFile(git, body.commit, body.path);
  if (file?.lineCount === null || file === null || body.line > file.lineCount) throw new RepositoryReadError("blame requires an existing text line");
  const output = utf8(await gitBytes(git, ["-c", "mailmap.file=/dev/null", "-c", "mailmap.blob=", "blame", "--no-textconv", "--ignore-revs-file", "", "--line-porcelain", "--encoding=UTF-8", "--no-progress", "-L", `${body.line},${body.line}`, body.commit, "--", body.path], 256 * 1024));
  const rows = output.split("\n");
  const match = /^([a-f0-9]{40}|[a-f0-9]{64}) \d+ \d+(?: \d+)?$/.exec(rows[0] ?? "");
  const author = rows.find((row) => row.startsWith("author "))?.slice(7);
  const summary = rows.find((row) => row.startsWith("summary "))?.slice(8);
  if (!match?.[1] || author === undefined || summary === undefined) throw new RepositoryReadError("Git line attribution is invalid");
  return { commit: match[1], path: body.path, line: body.line, author, summary };
}
export const controlPlanePlugin: ControlPlanePlugin = { apiVersion: 1, name: "git-blame", configure(raw) { z.object({}).strict().parse(raw); return prepareGitBlame(); } };
export function prepareGitBlame(): PreparedControlPlanePlugin {
  return {
    requiresExtensions: [{ kind: "dim.git-repositories.service", name: "default" }, { kind: "dim.git-repositories.access", name: "default" }],
    extensions: [{ kind: "dim.git-repositories.feature", name: "git-blame", value: { version: 1 } }, repositoryExtension({ name: "git-blame", async attach(context) {
      const access = repositoryAccessProvider(context.extensions);
      return { async handle(request, response, url) {
        const match = /^\/v1\/projects\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\/repositories\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\/blame$/.exec(url.pathname);
        if (!match || request.method !== "POST" || url.search !== "") return false;
        try {
          await context.serialize(async () => {
            const selector = { projectId: match[1]!, repositoryId: match[2]! };
            const { target } = await access.authorize(context, request, selector);
            const body = requestSchema.parse(await readBoundedJson(request));
            const git = { ...context.runtime, repository: target.repository, signal: AbortSignal.any([context.signal, AbortSignal.timeout(30_000)]) };
            await assertAdvertisedCommits(git, [body.commit], Object.keys(nativeRepositoryBranches(target.imported.policy)), await repositoryReadHistoryRefs(context, selector));
            const result = await readLineAttribution(git, body);
            await access.authorize(context, request, selector);
            sendJson(response, 200, result);
          });
        } catch (error) {
          if (error instanceof RepositoryAccessError) sendJson(response, error.status, { error: error.message });
          else if (error instanceof z.ZodError || error instanceof NativeGitBundleHttpError) sendJson(response, 400, { error: "blame request is invalid" });
          else if (error instanceof RepositoryReadError) sendJson(response, 422, { error: error.message });
          else sendJson(response, 503, { error: "repository attribution is unavailable or exceeds its limits" });
        }
        return true;
      }, async close() {} };
    } })],
    async start() { return { async close() {} }; }
  };
}
