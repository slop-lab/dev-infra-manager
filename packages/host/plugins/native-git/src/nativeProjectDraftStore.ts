import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { NativeProjectState } from "./nativeProjectState.js";
import type { NativeGitRootImportResult } from "./nativeGitRootImporterClient.js";
import { parseNativeProjectDraft, type NativeProjectDraft } from "./nativeProjectDraftCodec.js";
import { assertPrivateDraftDirectory, copyPrivateBundle, ensurePrivateDraftDirectory,
  inspectPrivateBundle, NativeProjectDraftStoreError, publishPrivateDraft,
  readPrivateDraftJson, replacePrivateDraft } from "./nativeProjectDraftFiles.js";
import type { NativeRepositoryBootstrapPolicy } from "./nativeRootBootstrapPolicy.js";

export { NativeProjectDraftStoreError } from "./nativeProjectDraftFiles.js";

export type NativeProjectDraftClaim = NativeRepositoryBootstrapPolicy & {
  readonly name: string;
  readonly projectId: string;
  readonly ownerHostId: string;
  readonly generationId: string;
  readonly expectedCommit: string;
  readonly expectedTree: string;
  readonly bundlePath: string;
};

export class NativeProjectDraftStore {
  readonly #state: NativeProjectState;
  readonly #draftDirectory: string;
  readonly #artifactRoot: string;

  constructor(readonly root: string) {
    this.#state = new NativeProjectState(root);
    this.#draftDirectory = join(root, "native-project-drafts");
    this.#artifactRoot = join(this.#draftDirectory, "artifacts");
  }

  async read(name: string, repositoryId: string): Promise<NativeProjectDraft | undefined> {
    const recordPath = this.#draftPath(name, repositoryId);
    await assertPrivateDraftDirectory(this.root);
    if (!await pathExists(this.#draftDirectory)) return undefined;
    await assertPrivateDraftDirectory(this.#draftDirectory);
    if (!await pathExists(join(this.#draftDirectory, name))) return undefined;
    await assertPrivateDraftDirectory(join(this.#draftDirectory, name));
    const raw = await readPrivateDraftJson(recordPath);
    if (raw === undefined) return undefined;
    let draft: NativeProjectDraft;
    try {
      draft = parseNativeProjectDraft(raw);
    } catch (error) {
      throw new NativeProjectDraftStoreError("native Project draft record is invalid", { cause: error });
    }
    if (draft.name !== name || draft.repositoryId !== repositoryId) {
      throw new NativeProjectDraftStoreError("native Project draft record name conflicts with its path");
    }
    await this.#assertArtifact(draft);
    return draft;
  }

  async claim(input: NativeProjectDraftClaim): Promise<NativeProjectDraft> {
    const recordPath = this.#draftPath(input.name, input.repositoryId);
    await assertPrivateDraftDirectory(this.root);
    const release = await this.#state.acquireProjectLock(input.name);
    try {
      const existing = await this.read(input.name, input.repositoryId);
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
      await ensurePrivateDraftDirectory(join(this.#draftDirectory, input.name));
      await ensurePrivateDraftDirectory(join(this.#artifactRoot, candidate.projectId));
      const artifactDirectory = join(this.#artifactRoot, candidate.projectId, candidate.repositoryId);
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

  async markRepositoryImported(
    name: string,
    repositoryId: string,
    importReceipt: NativeGitRootImportResult
  ): Promise<NativeProjectDraft> {
    const recordPath = this.#draftPath(name, repositoryId);
    await assertPrivateDraftDirectory(this.root);
    const release = await this.#state.acquireProjectLock(name);
    try {
      const current = await this.read(name, repositoryId);
      if (current === undefined) throw new NativeProjectDraftStoreError("native Project draft does not exist");
      if (current.phase === "repository-imported") {
        if (JSON.stringify(current.importReceipt) !== JSON.stringify(importReceipt)) {
          throw new NativeProjectDraftStoreError("native Project draft receipt replay changes immutable receipt");
        }
        return current;
      }
      let imported: NativeProjectDraft;
      try {
        imported = parseNativeProjectDraft({ ...current, phase: "repository-imported", importReceipt });
      } catch (error) {
        throw new NativeProjectDraftStoreError("native Project draft receipt does not match pending intent", { cause: error });
      }
      await replacePrivateDraft(recordPath, imported);
      return imported;
    } finally {
      await release();
    }
  }

  #draftPath(name: string, repositoryId: string): string {
    this.#state.projectPath(name);
    if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(repositoryId)) throw new NativeProjectDraftStoreError("invalid repository ID");
    return join(this.#draftDirectory, name, `${repositoryId}.json`);
  }

  #pending(input: NativeProjectDraftClaim, bundleDigest: string, bundleSize: number): NativeProjectDraft {
    try {
      return parseNativeProjectDraft({ schemaVersion: 3, recordType: "native-project-draft",
        phase: "import-pending", name: input.name, projectId: input.projectId, serviceId: "native-main",
        ownerHostId: input.ownerHostId, generationId: input.generationId, repositoryId: input.repositoryId, protectedRef: input.protectedRef, expectedCommit: input.expectedCommit,
        expectedTree: input.expectedTree, reviewPolicy: input.reviewPolicy,
        bundleDigest, bundleSize });
    } catch (error) {
      throw new NativeProjectDraftStoreError("native Project draft claim is invalid", { cause: error });
    }
  }

  async #assertArtifact(draft: NativeProjectDraft): Promise<void> {
    await assertPrivateDraftDirectory(this.#artifactRoot);
    await assertPrivateDraftDirectory(join(this.#artifactRoot, draft.projectId));
    const directory = join(this.#artifactRoot, draft.projectId, draft.repositoryId);
    await assertPrivateDraftDirectory(directory);
    const artifact = await inspectPrivateBundle(join(directory, `${draft.bundleDigest}.bundle`));
    if (artifact.digest !== draft.bundleDigest || artifact.size !== draft.bundleSize) {
      throw new NativeProjectDraftStoreError("native Project draft bundle does not match its record");
    }
  }


}

function sameIntent(left: NativeProjectDraft, right: NativeProjectDraft): boolean {
  const leftPending = { ...left, phase: "import-pending" };
  if (left.phase === "repository-imported") {
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
