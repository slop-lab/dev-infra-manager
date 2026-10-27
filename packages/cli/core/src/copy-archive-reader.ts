import { type Readable, type Writable } from "node:stream";
import path from "node:path";
import { CliHostProtocolError } from "@slop-lab/dim-contracts-cli-host";

export const copyArchiveMagic = Buffer.from("DIMCP1\0", "ascii");
const maxArchiveEntries = 100_000;
const maxArchiveHeaderBytes = 16 * 1024 * 1024;
const maxArchivePayloadBytes = 64 * 1024 * 1024 * 1024;
const maxArchivePathBytes = 4096;
const maxArchiveTargetBytes = 4096;

export type CopyArchiveEntry =
  | { readonly path: string; readonly type: "directory"; readonly mode: number }
  | { readonly path: string; readonly type: "file"; readonly mode: number; readonly size: number }
  | { readonly path: string; readonly type: "symlink"; readonly mode: number; readonly target: string };

export class CopyArchiveReader {
  private readonly iterator: AsyncIterator<unknown>;
  private buffered = Buffer.alloc(0);
  private entries = 0;
  private headerBytes = 0;
  private payloadBytes = 0;
  constructor(input: Readable) { this.iterator = input[Symbol.asyncIterator](); }
  async magic(): Promise<void> {
    if (!(await this.take(copyArchiveMagic.length)).equals(copyArchiveMagic)) throw new CliHostProtocolError("invalid copy archive header");
  }
  async entry(): Promise<CopyArchiveEntry | undefined> {
    const length = (await this.take(4)).readUInt32BE();
    if (length === 0) return undefined;
    if (length > 64 * 1024) throw new CliHostProtocolError("copy archive entry header is too large");
    this.entries++;
    this.headerBytes += length;
    if (this.entries > maxArchiveEntries) throw new CliHostProtocolError("copy archive has too many entries");
    if (this.headerBytes > maxArchiveHeaderBytes) throw new CliHostProtocolError("copy archive headers exceed their size limit");
    let value: unknown;
    try { value = JSON.parse((await this.take(length)).toString("utf8")); }
    catch (error) { throw new CliHostProtocolError("invalid copy archive entry", { cause: error }); }
    const entry = parseEntry(value);
    if (entry.type === "file") {
      this.payloadBytes += entry.size;
      if (this.payloadBytes > maxArchivePayloadBytes) throw new CliHostProtocolError("copy archive payload exceeds its size limit");
    }
    return entry;
  }
  async file(output: string, size: number, signal?: AbortSignal): Promise<void> {
    const { createWriteStream } = await import("node:fs");
    const { finished } = await import("node:stream/promises");
    const stream = createWriteStream(output, { flags: "wx", mode: 0o600 });
    try { await this.stream(stream, size, signal); stream.end(); await finished(stream); }
    finally { stream.destroy(); }
  }
  async stream(output: Writable, size: number, signal?: AbortSignal): Promise<void> {
    let remaining = size;
    while (remaining > 0) {
      signal?.throwIfAborted();
      const chunk = await this.take(Math.min(remaining, 64 * 1024));
      remaining -= chunk.length;
      if (!output.write(chunk)) await new Promise<void>((resolve, reject) => {
        const failed = (error: Error) => { output.off("drain", drained); reject(error); };
        const drained = () => { output.off("error", failed); resolve(); };
        output.once("error", failed); output.once("drain", drained);
      });
    }
  }
  async end(): Promise<void> {
    if (this.buffered.length !== 0) throw new CliHostProtocolError("copy archive has trailing data");
    for (;;) {
      const next = await this.iterator.next();
      if (next.done) return;
      const chunk = byteChunk(next.value);
      if (chunk.length !== 0) throw new CliHostProtocolError("copy archive has trailing data");
    }
  }
  private async take(length: number): Promise<Buffer> {
    while (this.buffered.length < length) {
      const next = await this.iterator.next();
      if (next.done) throw new CliHostProtocolError("copy archive ended unexpectedly");
      this.buffered = Buffer.concat([this.buffered, byteChunk(next.value)]);
    }
    const result = this.buffered.subarray(0, length);
    this.buffered = this.buffered.subarray(length);
    return result;
  }
}

export function unsafeCopyLinkTarget(entryPath: string, target: string): boolean {
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(entryPath), target));
  return !target || Buffer.byteLength(target) > maxArchiveTargetBytes || target.includes("\0") || target.includes("\\")
    || /^[A-Za-z]:/.test(target) || target.startsWith("//") || path.posix.isAbsolute(target)
    || resolved === ".." || resolved.startsWith("../");
}

function parseEntry(value: unknown): CopyArchiveEntry {
  if (!record(value)) throw new CliHostProtocolError("invalid copy archive entry");
  if (typeof value.path !== "string" || Buffer.byteLength(value.path) > maxArchivePathBytes || value.path.includes("\0")
    || typeof value.type !== "string" || !Number.isInteger(value.mode) || Number(value.mode) < 0 || Number(value.mode) > 0o777) throw new CliHostProtocolError("invalid copy archive entry");
  if (value.type === "directory") return { path: value.path, type: "directory", mode: Number(value.mode) };
  if (value.type === "file" && Number.isSafeInteger(value.size) && Number(value.size) >= 0) return { path: value.path, type: "file", mode: Number(value.mode), size: Number(value.size) };
  if (value.type === "symlink" && typeof value.target === "string") return { path: value.path, type: "symlink", mode: Number(value.mode), target: value.target };
  throw new CliHostProtocolError("unsupported copy archive entry type");
}

function byteChunk(value: unknown): Buffer {
  if (typeof value === "string") return Buffer.from(value);
  if (Buffer.isBuffer(value)) return value;
  throw new CliHostProtocolError("copy archive contained a non-byte chunk");
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
