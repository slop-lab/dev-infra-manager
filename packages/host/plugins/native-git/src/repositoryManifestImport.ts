import { defaultRepositoryReviewExtensions } from "./defaultRepositoryReviewPolicy.js";
import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parseDocument } from "yaml";
import { acquireLifecycleLock, atomicWrite, UserError } from "@slop-lab/dim-host-core";
import { loadPrivateJson } from "@slop-lab/dim-service-client-native-git";
import { parseNativeRootBootstrapManifestYaml } from "./nativeRootBootstrapPolicy.js";
import { normalizeRepositoryRef } from "./repositoryRef.js";
import { publicGitBranch, publicGitUrl } from "./public-git-source.js";
import { importNativeProjectPublicRepository, type PublicRepositoryImportInput, type PublicRepositoryImportDependencies } from "./publicRepositoryImport.js";

/** Parse declarative data only. The explicit import action authorizes these repository policies. */
export function previewNativeRepositoryManifest(projectId: string, manifest: string, reviewerId?: string) {
  if (Buffer.byteLength(manifest, "utf8") > 64 * 1024) throw new UserError("Repository manifest exceeds 64 KiB");
  const document = parseDocument(manifest, { uniqueKeys: true });
  if (document.errors.length) throw new UserError("Repository manifest is invalid YAML");
  const value: unknown = document.toJS({ maxAliasCount: 0 });
  if (!record(value) || !record(value.repositories)) throw new UserError("Repository manifest requires repositories");
  const entries = Object.entries(value.repositories);
  if (entries.length < 1 || entries.length > 16) throw new UserError("Repository manifest import supports 1–16 repositories");
  const repositories = entries.map(([repositoryId, raw]) => {
    if (!record(raw) || typeof raw.ref !== "string" || !record(raw.upstream)
      || typeof raw.upstream.url !== "string" || typeof raw.upstream.branch !== "string"
      || Object.keys(raw.upstream).some((key) => !["url", "branch"].includes(key))) {
      throw new UserError(`Repository '${repositoryId}' requires ref and public upstream.url/upstream.branch`);
    }
    const protectedRef = normalizeRepositoryRef(raw.ref);
    const policy = parseNativeRootBootstrapManifestYaml(manifest, protectedRef, repositoryId);
    return { repositoryId, url: publicGitUrl(raw.upstream.url).toString(), branch: publicGitBranch(raw.upstream.branch), protectedRef, policy: reviewerId === undefined ? policy.repositoryPolicy.extensions : defaultRepositoryReviewExtensions(policy.repositoryPolicy.extensions, reviewerId, policy.repositoryPolicy.branches),
      defaultRef: policy.repositoryPolicy.defaultRef!, branches: policy.repositoryPolicy.branches! };
  });
  const first = repositories[0]!;
  return { projectId, repositories, configurationRepositoryId: first.repositoryId, defaultWorkingRepositoryId: first.repositoryId };
}

export async function importNativeRepositoryManifest(input: Omit<PublicRepositoryImportInput, "repositoryId" | "url" | "branch" | "extensions" | "protectedRef"> & { manifest: string }, dependencies: PublicRepositoryImportDependencies = {}) {
  // Validate the entire graph before persisting intent or contacting the registrar.
  const plan = previewNativeRepositoryManifest(input.projectId, input.manifest, input.reviewerId);
  const lock = await acquireLifecycleLock({ root: input.stateRoot, name: `manifest-import-${createHash("sha256").update(input.projectId).digest("hex").slice(0, 24)}`, description: "Repository manifest import" });
  try {
    const path = join(input.stateRoot, "native-project-manifest-imports", `${input.name}.json`);
    const intent = { schemaVersion: 1, ownerHostId: input.selected.hostId, generationId: input.selected.nativeGit.generationId, ...plan };
    let previous: unknown;
    try { await lstat(path); previous = await loadPrivateJson(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (previous !== undefined && !isDeepStrictEqual(previous, intent)) throw new UserError("Repository manifest retry changes its immutable import plan");
    if (previous === undefined) await atomicWrite(path, intent);
    const repositories = [];
    for (const entry of plan.repositories) {
      try { repositories.push(await importNativeProjectPublicRepository({ ...input, repositoryId: entry.repositoryId, url: entry.url, branch: entry.branch, protectedRef: entry.protectedRef, extensions: entry.policy, defaultRef: entry.defaultRef, branches: entry.branches }, dependencies)); }
      catch (cause) { throw new UserError(`Repository '${entry.repositoryId}' import failed. Check its public upstream branch and enabled control-plane policy plugins, then retry the same manifest`, { cause }); }
    }
    return { projectId: input.projectId, repositories };
  } finally { await lock(); }
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
