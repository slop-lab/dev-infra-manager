import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { pullRequestSchema, PullRequestConflict, type PullRequest } from "@slop-lab/gs-pull-requests";

const selector = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const identity = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const maximumRecordBytes = 16 * 1024 * 1024;

export class PullRequestStore {
  constructor(readonly root: string, readonly synchronizeDirectory: (path: string) => Promise<void> = syncDirectory) {}

  async read(namespaceId: string, repositoryId: string, requestId: string): Promise<PullRequest | undefined> {
    if (!identity.test(requestId)) return undefined;
    const directory = await this.directory(namespaceId, repositoryId);
    let file;
    try {
      file = await open(join(directory, `${requestId}.json`), constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if (hasCode(error, "ENOENT")) return undefined;
      throw error;
    }
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.size > maximumRecordBytes || (stat.mode & 0o077) !== 0) {
        throw new PullRequestStorageError("Invalid pull request record");
      }
      const value: unknown = JSON.parse(await file.readFile("utf8"));
      const result = parseOwnedRecord(value);
      if (result.id !== requestId) throw new PullRequestStorageError("Pull request identity conflicts with storage");
      return result;
    } finally {
      await file.close();
    }
  }

  async list(namespaceId: string, repositoryId: string): Promise<readonly PullRequest[]> {
    const directory = await this.directory(namespaceId, repositoryId);
    const records: PullRequest[] = [];
    for (const name of await readdir(directory)) {
      if (!name.endsWith(".json")) continue;
      const record = await this.read(namespaceId, repositoryId, name.slice(0, -5));
      if (record !== undefined) records.push(record);
    }
    return records.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async save(namespaceId: string, repositoryId: string, value: PullRequest): Promise<void> {
    const record = parseOwnedRecord(value);
    const serialized = `${JSON.stringify(record)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > maximumRecordBytes) {
      throw new PullRequestConflict("Pull request record exceeds its 16 MiB storage bound");
    }
    const directory = await this.directory(namespaceId, repositoryId);
    await this.synchronizeDirectory(this.root);
    await this.synchronizeDirectory(join(this.root, namespaceId));
    const temporary = join(directory, `${randomUUID()}.tmp`);
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await file.writeFile(serialized);
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await rename(temporary, join(directory, `${record.id}.json`));
      await this.synchronizeDirectory(directory);
    } finally {
      await unlink(temporary).catch((error: unknown) => {
        if (!hasCode(error, "ENOENT")) throw error;
      });
    }
  }

  private async directory(namespaceId: string, repositoryId: string): Promise<string> {
    if (!selector.test(namespaceId) || !selector.test(repositoryId)) throw new PullRequestStorageError("Invalid repository selector");
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const rootInfo = await lstat(this.root);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || rootInfo.uid !== process.getuid?.() || (rootInfo.mode & 0o077) !== 0) {
      throw new PullRequestStorageError("Pull request storage must be a private owned directory");
    }
    let directory = this.root;
    for (const part of [namespaceId, repositoryId]) {
      directory = join(directory, part);
      await mkdir(directory, { mode: 0o700 }).catch((error: unknown) => {
        if (!hasCode(error, "EEXIST")) throw error;
      });
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) {
        throw new PullRequestStorageError("Pull request storage must be private owned directories");
      }
    }
    return directory;
  }
}

function parseOwnedRecord(value: unknown): PullRequest {
  const record = pullRequestSchema.parse(value);
  const values = [record.id, ...record.revisions.map((revision) => revision.id), ...record.comments.flatMap((comment) => [comment.id, comment.revisionId])];
  if (!values.every((entry) => identity.test(entry))) throw new PullRequestStorageError("Pull request identities must be canonical UUIDs");
  const revisions = new Set(record.revisions.map((revision) => revision.id));
  if (record.comments.some((comment) => !revisions.has(comment.revisionId))) {
    throw new PullRequestStorageError("Pull request comment references an unknown revision");
  }
  return record;
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export class PullRequestStorageError extends Error {
  readonly name = "PullRequestStorageError";
}
