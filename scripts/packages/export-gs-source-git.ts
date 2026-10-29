import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { chmod, copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundleRef, SourceExportError, sourcePrefix } from "./export-gs-source-types.ts";
import type { GitContext, GitMode, LockRecord, ObjectFormat, TreeEntry } from "./export-gs-source-types.ts";
import { createHash } from "node:crypto";

const inheritedEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
);

const gitEnvironment = {
  ...inheritedEnvironment,
  GIT_MASTER: "1",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_NO_LAZY_FETCH: "1",
  GIT_GRAFT_FILE: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_ALLOW_PROTOCOL: "file",
} satisfies NodeJS.ProcessEnv;

function gitArguments(repository: string, arguments_: readonly string[]): readonly string[] {
  return ["--no-replace-objects", "-c", "protocol.file.allow=always", "-C", repository, ...arguments_];
}

export function gitText(repository: string, arguments_: readonly string[]): string {
  const result = spawnSync("git", gitArguments(repository, arguments_), { encoding: "utf8", env: gitEnvironment });
  if (result.error) throw new SourceExportError(`git could not start: ${result.error.message}`, { cause: result.error });
  if (result.status !== 0) throw new SourceExportError(`git command failed (${arguments_[0] ?? "unknown"}): ${result.stderr.trim()}`);
  return result.stdout.trim();
}

export function gitBuffer(repository: string, arguments_: readonly string[]): Buffer {
  const result = spawnSync("git", gitArguments(repository, arguments_), { env: gitEnvironment, maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw new SourceExportError(`git could not start: ${result.error.message}`, { cause: result.error });
  if (result.status !== 0) throw new SourceExportError(`git command failed (${arguments_[0] ?? "unknown"})`);
  return result.stdout;
}

function parseObjectFormat(value: string): ObjectFormat {
  if (value === "sha1" || value === "sha256") return value;
  throw new SourceExportError(`unsupported Git object format: ${value}`);
}

function decodeUtf8(value: Buffer, purpose: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch (error) {
    throw new SourceExportError(`${purpose} is not valid UTF-8`, { cause: error });
  }
}

function parseMode(value: string): GitMode {
  if (value === "100644" || value === "100755" || value === "120000") return value;
  throw new SourceExportError(`unsupported Git file mode: ${value}`);
}

function nulRecords(value: Buffer): readonly Buffer[] {
  const records: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== 0) continue;
    if (index > start) records.push(value.subarray(start, index));
    start = index + 1;
  }
  if (start !== value.length) throw new SourceExportError("Git returned an unterminated tree record");
  return records;
}

function parseTreeRecord(record: Buffer): Omit<TreeEntry, "content"> {
  const value = decodeUtf8(record, "Git tree path");
  const separator = value.indexOf("\t");
  const metadata = separator < 0 ? "" : value.slice(0, separator);
  const sourcePath = separator < 0 ? "" : value.slice(separator + 1);
  const match = /^(100644|100755|120000) blob ([0-9a-f]{40}|[0-9a-f]{64})$/.exec(metadata);
  if (!match) throw new SourceExportError(`unsupported Git tree entry: ${value}`);
  const mode = match[1];
  const blobId = match[2];
  if (!mode || !blobId || !sourcePath || !sourcePath.startsWith(sourcePrefix)) throw new SourceExportError("invalid GS tree entry");
  const exportPath = sourcePath.slice(sourcePrefix.length);
  if (exportPath.length === 0) throw new SourceExportError("GS source tree contains an empty export path");
  return { sourcePath, exportPath, blobId, mode: parseMode(mode) };
}

export function inspectGitSource(source: string, commit: string): GitContext {
  if (gitText(source, ["rev-parse", "--show-toplevel"]) !== source) throw new SourceExportError("source must be the absolute repository worktree root");
  if (gitText(source, ["rev-parse", "--is-shallow-repository"]) !== "false") throw new SourceExportError("selected source repository must contain full history");
  const objectFormat = parseObjectFormat(gitText(source, ["rev-parse", "--show-object-format"]));
  const expectedLength = objectFormat === "sha1" ? 40 : 64;
  if (!new RegExp(`^[0-9a-f]{${expectedLength}}$`).test(commit)) throw new SourceExportError(`commit must be a full ${expectedLength}-hex object ID`);
  const selected = gitText(source, ["rev-parse", "--verify", `${commit}^{commit}`]);
  if (selected !== commit) throw new SourceExportError("selected commit did not resolve exactly");
  const tree = gitText(source, ["rev-parse", `${commit}^{tree}`]);
  const prefixTree = gitText(source, ["rev-parse", `${commit}:packages/gs`]);
  return { source, commit, objectFormat, tree, prefixTree };
}

export function readGsTree(context: GitContext): readonly TreeEntry[] {
  const records = nulRecords(gitBuffer(context.source, ["ls-tree", "-rz", "--full-tree", context.commit, "--", "packages/gs"]));
  if (records.length === 0) throw new SourceExportError("selected commit has no packages/gs source tree");
  return records.map((record) => {
    const entry = parseTreeRecord(record);
    return { ...entry, content: gitBuffer(context.source, ["cat-file", "blob", entry.blobId]) };
  });
}

export function readMonorepoLock(context: GitContext): LockRecord | null {
  const record = gitBuffer(context.source, ["ls-tree", "-z", context.commit, "--", "pnpm-lock.yaml"]);
  if (record.length === 0) return null;
  const value = decodeUtf8(record.subarray(0, record.length - 1), "root lock tree record");
  const match = /^100644 blob ([0-9a-f]{40}|[0-9a-f]{64})\tpnpm-lock\.yaml$/.exec(value);
  const blobId = match?.[1];
  if (!blobId) throw new SourceExportError("root pnpm-lock.yaml is not a regular Git blob");
  const content = gitBuffer(context.source, ["cat-file", "blob", blobId]);
  return { sourcePath: "pnpm-lock.yaml", blobId, sha256: createHash("sha256").update(content).digest("hex") };
}

export async function createHistoryBundle(context: GitContext, destination: string): Promise<string> {
  const temporary = await mkdtemp(join(tmpdir(), "gs-source-history-"));
  const bare = join(temporary, "repository.git");
  const bundle = join(temporary, "source-history.bundle");
  try {
    gitText(temporary, ["init", "--bare", `--object-format=${context.objectFormat}`, bare]);
    gitText(bare, ["fetch", "--no-tags", "--force", "--no-write-fetch-head", context.source, `+${context.commit}:${bundleRef}`]);
    if (gitText(bare, ["rev-parse", bundleRef]) !== context.commit) throw new SourceExportError("private history repository selected the wrong commit");
    gitText(bare, ["bundle", "create", bundle, bundleRef]);
    gitText(bare, ["bundle", "verify", bundle]);
    await copyFile(bundle, destination, constants.COPYFILE_EXCL);
    await chmod(destination, 0o600);
    return createHash("sha256").update(await readFile(destination)).digest("hex");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
