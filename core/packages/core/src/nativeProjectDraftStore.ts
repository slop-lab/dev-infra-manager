import { lstat } from "node:fs/promises";
import { basename, join } from "node:path";
import { LifecycleState } from "./lifecycleState.js";
import type { NativeGitRootImportResult } from "./nativeGitRootImporterClient.js";
import { parseNativeProjectDraft, type NativeProjectDraft } from "./nativeProjectDraftCodec.js";
import { assertPrivateDraftDirectory, copyPrivateBundle, ensurePrivateDraftDirectory,
  inspectPrivateBundle, NativeProjectDraftStoreError, publishPrivateDraft,
  readPrivateDraftJson, replacePrivateDraft } from "./nativeProjectDraftFiles.js";
import type { NativeRootBootstrapPolicy } from "./nativeRootBootstrapPolicy.js";

export { NativeProjectDraftStoreError } from "./nativeProjectDraftFiles.js";

export type NativeProjectDraftClaim = NativeRootBootstrapPolicy & {
  readonly name: string;
  readonly projectId: string;
  readonly ownerHostId: string;
  readonly generationId: string;
  readonly expectedCommit: string;
  readonly expectedTree: string;
  readonly bundlePath: string;
};

export class NativeProjectDraftStore {
  readonly #state: LifecycleState;
  readonly #draftDirectory: string;
  readonly #artifactRoot: string;

  constructor(readonly root: string) {
    this.#state = new LifecycleState(root);
    this.#draftDirectory = join(root, "native-project-drafts");
    this.#artifactRoot = join(this.#draftDirectory, "artifacts");
  }

  async read(name: string): Promise<NativeProjectDraft | undefined> {
    const recordPath = this.#draftPath(name);
    await assertPrivateDraftDirectory(this.root);
    if (!await pathExists(this.#draftDirectory)) return undefined;
    await assertPrivateDraftDirectory(this.#draftDirectory);
    const raw = await readPrivateDraftJson(recordPath);
    if (raw === undefined) return undefined;
    let draft: NativeProjectDraft;
    try {
      draft = parseNativeProjectDraft(raw);
    } catch (error) {
      throw new NativeProjectDraftStoreError("native Project draft record is invalid", { cause: error });
    }
    if (draft.name !== name) {
      throw new NativeProjectDraftStoreError("native Project draft record name conflicts with its path");
    }
    await this.#assertArtifact(draft);
    return draft;
  }

  async claim(input: NativeProjectDraftClaim): Promise<NativeProjectDraft> {
    const recordPath = this.#draftPath(input.name);
    await assertPrivateDraftDirectory(this.root);
    const release = await this.#state.acquireProjectLock(input.name);
    try {
      await this.#refuseGiteaProject(input.name);
      const existing = await this.read(input.name);
      if (existing !== undefined) {
        const source = await inspectPrivateBundle(input.bundlePath);
        const candidate = this.#pending(input, source.digest, source.size);
        if (!sameIntent(existing, candidate)) {
          throw new NativeProjectDraftStoreError("native Project draft replay changes immutable intent");
        }
        return existing;
      }
      const source = await inspectPrivateBundle(input.bundlePath);
      const candidate = this.#pending(input, source.digest, source.size);
      await ensurePrivateDraftDirectory(this.#draftDirectory);
      await ensurePrivateDraftDirectory(this.#artifactRoot);
      const artifactDirectory = join(this.#artifactRoot, candidate.projectId);
      const bundle = await copyPrivateBundle(input.bundlePath, artifactDirectory);
      if (bundle.digest !== source.digest || bundle.size !== source.size) {
        throw new NativeProjectDraftStoreError("native Project draft source bundle changed before publication");
      }
      const pending = this.#pending(input, bundle.digest, bundle.size);
      await publishPrivateDraft(recordPath, pending);
      return pending;
    } finally {
      await release();
    }
  }

  async markRootImported(
    name: string,
    importReceipt: NativeGitRootImportResult
  ): Promise<NativeProjectDraft> {
    const recordPath = this.#draftPath(name);
    await assertPrivateDraftDirectory(this.root);
    const release = await this.#state.acquireProjectLock(name);
    try {
      await this.#refuseGiteaProject(name);
      const current = await this.read(name);
      if (current === undefined) throw new NativeProjectDraftStoreError("native Project draft does not exist");
      if (current.phase === "root-imported") {
        if (JSON.stringify(current.importReceipt) !== JSON.stringify(importReceipt)) {
          throw new NativeProjectDraftStoreError("native Project draft receipt replay changes immutable receipt");
        }
        return current;
      }
      let imported: NativeProjectDraft;
      try {
        imported = parseNativeProjectDraft({ ...current, phase: "root-imported", importReceipt });
      } catch (error) {
        throw new NativeProjectDraftStoreError("native Project draft receipt does not match pending intent", { cause: error });
      }
      await replacePrivateDraft(recordPath, imported);
      return imported;
    } finally {
      await release();
    }
  }

  #draftPath(name: string): string {
    return join(this.#draftDirectory, basename(this.#state.projectPath(name)));
  }

  #pending(input: NativeProjectDraftClaim, bundleDigest: string, bundleSize: number): NativeProjectDraft {
    try {
      return parseNativeProjectDraft({ schemaVersion: 2, recordType: "native-project-draft",
        phase: "import-pending", name: input.name, projectId: input.projectId, serviceId: "native-main",
        ownerHostId: input.ownerHostId, generationId: input.generationId, rootRepositoryId: "root",
        rootAlias: input.rootAlias, protectedRef: input.protectedRef, expectedCommit: input.expectedCommit,
        expectedTree: input.expectedTree, reviewPolicy: input.reviewPolicy,
        bundleDigest, bundleSize });
    } catch (error) {
      throw new NativeProjectDraftStoreError("native Project draft claim is invalid", { cause: error });
    }
  }

  async #assertArtifact(draft: NativeProjectDraft): Promise<void> {
    await assertPrivateDraftDirectory(this.#artifactRoot);
    const directory = join(this.#artifactRoot, draft.projectId);
    await assertPrivateDraftDirectory(directory);
    const artifact = await inspectPrivateBundle(join(directory, `${draft.bundleDigest}.bundle`));
    if (artifact.digest !== draft.bundleDigest || artifact.size !== draft.bundleSize) {
      throw new NativeProjectDraftStoreError("native Project draft bundle does not match its record");
    }
  }

  async #refuseGiteaProject(name: string): Promise<void> {
    try {
      await lstat(this.#state.projectPath(name));
    } catch (error) {
      if (errorCode(error) === "ENOENT") return;
      throw new NativeProjectDraftStoreError("same-name Gitea Project node cannot be inspected", { cause: error });
    }
    throw new NativeProjectDraftStoreError("same-name Gitea Project node already exists");
  }
}

function sameIntent(left: NativeProjectDraft, right: NativeProjectDraft): boolean {
  if (left.schemaVersion === 1) {
    if (right.schemaVersion !== 2) return false;
    return left.phase === "root-imported"
      && left.name === right.name && left.projectId === right.projectId && left.serviceId === right.serviceId
      && left.ownerHostId === right.ownerHostId && left.rootRepositoryId === right.rootRepositoryId
      && left.rootAlias === right.rootAlias && left.protectedRef === right.protectedRef
      && left.expectedCommit === right.expectedCommit && left.expectedTree === right.expectedTree
      && left.bundleDigest === right.bundleDigest && left.bundleSize === right.bundleSize
      && JSON.stringify(left.requiredJobs) === JSON.stringify(right.reviewPolicy.requiredJobs.map(
        ({ name, kind }) => ({ name, kind })
      ))
      && JSON.stringify(left.reviewPolicy.requiredReviewerIds)
        === JSON.stringify(right.reviewPolicy.requiredReviewerIds)
      && JSON.stringify(left.reviewPolicy.pathReviewerRules) === JSON.stringify(right.reviewPolicy.pathReviewerRules);
  }
  const leftPending = { ...left, phase: "import-pending" };
  if (left.phase === "root-imported") {
    Reflect.deleteProperty(leftPending, "importReceipt");
    return JSON.stringify({ ...leftPending, generationId: right.generationId }) === JSON.stringify(right);
  }
  return JSON.stringify(leftPending) === JSON.stringify(right);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw new NativeProjectDraftStoreError("native Project draft path cannot be inspected", { cause: error });
  }
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
}
