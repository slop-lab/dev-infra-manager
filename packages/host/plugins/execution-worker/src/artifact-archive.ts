import { constants } from "node:fs";
import { open, rm, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { executionArtifactLimits, executionArtifactSchema, type ExecutionArtifact } from "@slop-lab/dim-contracts-execution";
import { artifactArchiveLimit, artifactArchivePath, artifactPaxBytes, ArtifactHandoffError, type BackendArtifactSource } from "./artifact-source.js";

const text = (bytes: Buffer) => new TextDecoder("utf-8", { fatal: true }).decode(bytes);
function field(header: Buffer, start: number, length: number): string {
  const bytes = header.subarray(start, start + length), end = bytes.indexOf(0);
  return text(end < 0 ? bytes : bytes.subarray(0, end));
}
function octal(header: Buffer, start: number, length: number): number {
  const value = field(header, start, length).trim();
  if (!/^[0-7]+$/.test(value)) throw new ArtifactHandoffError();
  const number = Number.parseInt(value, 8); if (!Number.isSafeInteger(number)) throw new ArtifactHandoffError(); return number;
}
function safePath(name: string): void {
  if (!name || Buffer.byteLength(name) > 1024 || /[\\\x00-\x1f\x7f]/.test(name) || name.split("/").some(part => !part || part === "." || part === "..")) throw new ArtifactHandoffError();
}
function paxPath(bytes: Buffer): string | undefined {
  let offset = 0, path: string | undefined; const keys = new Set<string>();
  while (offset < bytes.length) {
    const space = bytes.indexOf(32, offset), digits = bytes.subarray(offset, space).toString("ascii");
    if (space < offset || space - offset > 8 || !/^[1-9][0-9]*$/.test(digits)) throw new ArtifactHandoffError();
    const end = offset + Number(digits);
    if (end > bytes.length || end <= space + 2 || bytes[end - 1] !== 10) throw new ArtifactHandoffError();
    const record = bytes.subarray(space + 1, end - 1), separator = record.indexOf(61), key = text(record.subarray(0, separator));
    if (separator < 1 || keys.has(key)) throw new ArtifactHandoffError(); keys.add(key);
    if (key !== "SCHILY.xattr.security.capability") {
      const value = text(record.subarray(separator + 1));
      if (key === "path") { safePath(value.endsWith("/") ? value.slice(0, -1) : value); path = value; }
      else if (key === "uid" || key === "gid") { if (!/^[0-9]{1,20}$/.test(value)) throw new ArtifactHandoffError(); }
      else if (!["mtime", "atime", "ctime"].includes(key) || !/^-?[0-9]{1,20}(?:\.[0-9]{1,9})?$/.test(value)) throw new ArtifactHandoffError();
    }
    offset = end;
  }
  return path;
}
class ArchiveReader {
  position = 0;
  constructor(readonly file: FileHandle, readonly size: number) {}
  async read(length: number): Promise<Buffer> {
    if (length > this.size - this.position) throw new ArtifactHandoffError();
    const bytes = Buffer.alloc(length); let offset = 0;
    while (offset < length) { const part = await this.file.read(bytes, offset, length - offset, null); if (part.bytesRead === 0) throw new ArtifactHandoffError(); offset += part.bytesRead; }
    this.position += length; return bytes;
  }
  async padding(length: number): Promise<void> { if ((await this.read(length)).some(value => value !== 0)) throw new ArtifactHandoffError(); }
}

export async function captureArchiveArtifacts(input: { readonly root: string; readonly pending: string; readonly source: Extract<BackendArtifactSource, { kind: "archive" }> }, logs: readonly ExecutionArtifact[]): Promise<readonly ExecutionArtifact[]> {
  if (input.source.index.length === 0) return [];
  const expected = new Map(input.source.index.map(entry => [entry.name, entry])), seen = new Set<string>();
  if (expected.size !== input.source.index.length || expected.get("")?.kind !== "directory") throw new ArtifactHandoffError();
  const file = await open(artifactArchivePath(input.root, input.source.nonce), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const created: string[] = [], captured: ExecutionArtifact[] = [];
  try {
    const before = await file.stat();
    if (!before.isFile() || before.nlink !== 1 || before.uid !== process.getuid?.() || (before.mode & 0o077) !== 0 || before.size > artifactArchiveLimit(input.source.index) || before.size % 512 !== 0) throw new ArtifactHandoffError();
    const reader = new ArchiveReader(file, before.size); let headers = 0, extended = false, override: string | undefined;
    let total = logs.reduce((sum, entry) => sum + entry.bytes, 0);
    for (;;) {
      const header = await reader.read(512);
      if (header.every(value => value === 0)) {
        await reader.padding(512);
        while (reader.position < reader.size) await reader.padding(Math.min(64 * 1024, reader.size - reader.position));
        if (extended || seen.size !== expected.size) throw new ArtifactHandoffError(); break;
      }
      if (++headers > input.source.index.length * 2 || field(header, 257, 6) !== "ustar" || field(header, 263, 2) !== "00") throw new ArtifactHandoffError();
      const checksum = header.reduce((sum, value, index) => sum + (index >= 148 && index < 156 ? 32 : value), 0);
      if (checksum !== octal(header, 148, 8)) throw new ArtifactHandoffError();
      const size = octal(header, 124, 12), type = field(header, 156, 1), prefix = field(header, 345, 155);
      const raw = field(header, 0, 100), name = override ?? (prefix ? prefix + "/" + raw : raw);
      if (type === "x") {
        if (extended || size > artifactPaxBytes) throw new ArtifactHandoffError(); safePath(name);
        override = paxPath(await reader.read(size)); await reader.padding((512 - size % 512) % 512); extended = true; continue;
      }
      const canonical = type === "5" && name.endsWith("/") ? name.slice(0, -1) : name;
      safePath(canonical);
      if (canonical !== ".dim-ci-artifacts" && !canonical.startsWith(".dim-ci-artifacts/")) throw new ArtifactHandoffError();
      const relative = canonical === ".dim-ci-artifacts" ? "" : canonical.slice(".dim-ci-artifacts/".length), entry = expected.get(relative);
      if (!entry || seen.has(relative) || field(header, 157, 100) !== "" || size !== entry.size || !(type === "5" && entry.kind === "directory" || (type === "0" || type === "") && entry.kind === "file")) throw new ArtifactHandoffError();
      seen.add(relative); override = undefined; extended = false;
      if (entry.kind === "directory") continue;
      if (size > executionArtifactLimits.fileBytes || logs.length + captured.length >= executionArtifactLimits.files || total + size > executionArtifactLimits.totalBytes) throw new ArtifactHandoffError();
      const artifactName = "files/" + relative, id = createHash("sha256").update(artifactName).digest("hex"), path = join(input.pending, id);
      const destination = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); created.push(path);
      const hash = createHash("sha256");
      try {
        for (let remaining = size; remaining > 0;) { const bytes = await reader.read(Math.min(64 * 1024, remaining)); hash.update(bytes); await destination.writeFile(bytes); remaining -= bytes.length; }
        await destination.sync();
      } finally { await destination.close(); }
      await reader.padding((512 - size % 512) % 512); total += size;
      captured.push(executionArtifactSchema.parse({ id, name: artifactName, bytes: size, sha256: "sha256:" + hash.digest("hex"),
        mediaType: artifactName.endsWith(".png") ? "image/png" : artifactName.endsWith(".json") ? "application/json" : /\.(log|txt|md)$/.test(artifactName) ? "text/plain" : "application/octet-stream" }));
    }
    const after = await file.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new ArtifactHandoffError();
    return captured;
  } catch (error) { await Promise.all(created.map(path => rm(path))); throw error; }
  finally { await file.close(); }
}
