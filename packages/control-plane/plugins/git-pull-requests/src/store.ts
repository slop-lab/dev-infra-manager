import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { syncDirectory } from "@slop-lab/dim-control-plane-plugin-git-repositories/plugin-api";
import { pullRequestSchema, PullRequestConflict, type PullRequest } from "@slop-lab/gs-pull-requests";

const selector = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const maximumRecordBytes = 16 * 1024 * 1024;
const id = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export class PullRequestStore {
  constructor(readonly root: string) {}
  private async directory(projectId: string, repositoryId: string): Promise<string> {
    if (!selector.test(projectId) || !selector.test(repositoryId)) throw new Error("Invalid repository selector");
    let directory = this.root;
    for (const part of [projectId, repositoryId]) {
      directory = join(directory, part);
      await mkdir(directory, { mode: 0o700 }).catch((error: unknown) => { if (!isMissingCode(error, "EEXIST")) throw error; });
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw new Error("Pull request storage must be private owned directories");
    }
    return directory;
  }
  async read(projectId: string, repositoryId: string, requestId: string): Promise<PullRequest | undefined> {
    if (!id.test(requestId)) return undefined;
    const directory = await this.directory(projectId, repositoryId);
    let file;
    try { file = await open(join(directory, `${requestId}.json`), constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if (isMissingCode(error, "ENOENT")) return undefined; throw error; }
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.size > maximumRecordBytes || (stat.mode & 0o077) !== 0) throw new Error("Invalid pull request record");
      const result = parseDimRecord(JSON.parse(await file.readFile("utf8")));
      if (result.id !== requestId) throw new Error("Pull request identity conflicts with storage");
      return result;
    } finally { await file.close(); }
  }
  async list(projectId: string, repositoryId: string): Promise<readonly PullRequest[]> {
    const directory = await this.directory(projectId, repositoryId);
    const records: PullRequest[] = [];
    for (const name of await readdir(directory)) {
      if (!name.endsWith(".json")) continue;
      const record = await this.read(projectId, repositoryId, name.slice(0, -5));
      if (record !== undefined) records.push(record);
    }
    return records.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }
  async save(projectId: string, repositoryId: string, value: PullRequest): Promise<void> {
    const record = parseDimRecord(value);
    const serialized = `${JSON.stringify(record)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > maximumRecordBytes) throw new PullRequestConflict("Pull request record exceeds its 16 MiB storage bound");
    const directory = await this.directory(projectId, repositoryId);
    // Persist newly created ancestor entries before publishing a durable owner
    // record. Repeat on retries, including after an interrupted directory sync.
    await syncDirectory(this.root);
    await syncDirectory(join(this.root, projectId));
    const temporary = join(directory, `${randomUUID()}.tmp`);
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(serialized); await file.sync(); }
    finally { await file.close(); }
    try {
      await rename(temporary, join(directory, `${record.id}.json`));
      const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { await handle.sync(); } finally { await handle.close(); }
    } finally { await unlink(temporary).catch((error: unknown) => { if (!isMissingCode(error, "ENOENT")) throw error; }); }
  }
}
function isMissingCode(error: unknown, code: string): boolean { return error instanceof Error && "code" in error && error.code === code; }

function parseDimRecord(value: unknown): PullRequest {
  const record = pullRequestSchema.parse(value);
  if (![record.id, ...record.revisions.map((revision) => revision.id), ...record.comments.flatMap((comment) => [comment.id, comment.revisionId])].every((value) => id.test(value))) throw new Error("DIM pull request identities must be canonical UUIDs");
  const revisions = new Set(record.revisions.map((revision) => revision.id));
  if (record.comments.some((comment) => !revisions.has(comment.revisionId))) throw new Error("DIM pull request comment references an unknown revision");
  return record;
}
