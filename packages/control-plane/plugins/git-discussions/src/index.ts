import { randomUUID } from "node:crypto";
import { z } from "zod";
import { anchorSchema, assertVersion, PullRequestConflict } from "@slop-lab/git-pull-requests";
import type { ControlPlanePlugin } from "@slop-lab/dim-control-plane-core/plugin-api";
import { repositoryExtension, repositoryAccessProvider, RepositoryAccessError, readBoundedJson, NativeGitBundleHttpError, sendJson } from "@slop-lab/dim-control-plane-plugin-git-repositories/plugin-api";
import { pullRequestService } from "@slop-lab/dim-control-plane-plugin-git-pull-requests/plugin-api";
import { gitDiffService, validateDiffAnchor } from "@slop-lab/dim-control-plane-plugin-git-diff/plugin-api";
const comment = z.object({ expectedVersion: z.number().int().positive(), revisionId: z.string().uuid(), body: z.string().trim().min(1).max(3000), anchor: anchorSchema.optional() }).strict();
const scope = "([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)";
const route = new RegExp(`^/v1/projects/${scope}/repositories/${scope}/pull-requests/([0-9a-f-]{36})/comments$`);
export const controlPlanePlugin: ControlPlanePlugin = { apiVersion: 1, name: "git-discussions", configure(raw) {
  z.object({}).strict().parse(raw);
  return {
    requiresExtensions: [{ kind: "dim.git-pull-requests.service", name: "default" }, { kind: "dim.git-diff.service", name: "default" }, { kind: "dim.git-repositories.access", name: "default" }],
    extensions: [{ kind: "dim.git-repositories.feature", name: "git-discussions", value: { version: 1 } }, repositoryExtension({ name: "git-discussions", async attach(context) { return { async close() {}, async handle(request, response, url) {
      const match = url.search === "" ? route.exec(url.pathname) : null;
      if (match === null) return false;
      if (request.method !== "POST") { sendJson(response, 405, { error: "Method not allowed" }); return true; }
      try {
        const body = comment.parse(await readBoundedJson(request));
        await context.serialize(async () => {
          const selector = { projectId: match[1]!, repositoryId: match[2]! };
          const access = await repositoryAccessProvider(context.extensions).authorize(context, request, selector);
          const service = pullRequestService(context.extensions);
          const record = await service.read(context, selector, match[3]!);
          if (record === undefined) { sendJson(response, 404, { error: "Pull request not found" }); return; }
          assertVersion(record, body.expectedVersion);
          await repositoryAccessProvider(context.extensions).authorize(context, request, { ...selector, protectedRef: record.targetRef });
          const revision = record.revisions.find((revision) => revision.id === body.revisionId);
          if (revision === undefined) throw new PullRequestConflict("Comment revision does not belong to this pull request");
          if (body.anchor !== undefined) {
            const snapshot = await gitDiffService(context.extensions).snapshot(context, { ...selector, baseCommit: revision.targetCommit, headCommit: revision.sourceCommit });
            if (!validateDiffAnchor(snapshot, { ...body.anchor, baseCommit: revision.targetCommit, headCommit: revision.sourceCommit })) throw new PullRequestConflict("Comment anchor is not a visible line in this revision");
          }
          const updated = await service.appendComment(context, selector, record.id, body.expectedVersion, { id: randomUUID(), actorId: access.actorId, body: body.body, revisionId: revision.id, createdAt: new Date().toISOString(), ...(body.anchor === undefined ? {} : { anchor: body.anchor }) });
          sendJson(response, 201, updated);
        });
      } catch (error) {
        if (error instanceof RepositoryAccessError) sendJson(response, error.status, { error: error.message });
        else if (error instanceof PullRequestConflict) sendJson(response, 409, { error: error.message });
        else if (error instanceof z.ZodError || error instanceof NativeGitBundleHttpError) sendJson(response, 400, { error: "Invalid discussion input" });
        else throw error;
      }
      return true;
    } }; } })], async start() { return { async close() {} }; }
  };
} };
