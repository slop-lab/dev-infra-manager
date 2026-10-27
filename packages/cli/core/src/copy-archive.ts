import { randomUUID } from "node:crypto";
import { createReadStream, type ReadStream } from "node:fs";
import { chmod, lstat, mkdir, readlink, realpath, rename, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { Readable, type Writable } from "node:stream";
import { CliHostProtocolError } from "@slop-lab/dim-contracts-cli-host";
import { CopyArchiveReader, copyArchiveMagic, type CopyArchiveEntry as Entry, unsafeCopyLinkTarget } from "./copy-archive-reader.js";

type CopyArchiveOperations = {
  readonly rename: (source: string, destination: string) => Promise<void>;
  readonly remove?: (target: string) => Promise<void>;
};
const copyArchiveOperations: CopyArchiveOperations = { rename };
export type StagedCopyArchive = { readonly publish: () => Promise<void>; readonly discard: () => Promise<void> };

export function createCopyArchive(source: string, recursive: boolean, signal?: AbortSignal): Readable {
  return Readable.from(pack(path.resolve(source), recursive, signal));
}

async function* pack(source: string, recursive: boolean, signal?: AbortSignal): AsyncGenerator<Buffer> {
  yield copyArchiveMagic;
  const root = await safeStat(source, "local copy source");
  if (root.isDirectory() && !recursive) throw new CliHostProtocolError("local copy source is a directory; use --recursive");
  if (root.isSymbolicLink()) throw new CliHostProtocolError("a copied symlink must be contained in a recursive directory source");
  yield* packEntry(source, ".", await realpath(source), signal);
  yield Buffer.alloc(4);
}

async function* packEntry(absolute: string, relative: string, root: string, signal?: AbortSignal): AsyncGenerator<Buffer> {
  signal?.throwIfAborted();
  const info = await safeStat(absolute, "local copy source");
  if (info.isDirectory()) {
    yield header({ path: relative, type: "directory", mode: info.mode & 0o777 });
    const entries = await import("node:fs/promises").then(({ readdir }) => readdir(absolute, { withFileTypes: true }));
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      yield* packEntry(path.join(absolute, entry.name), relative === "." ? entry.name : `${relative}/${entry.name}`, root, signal);
    }
    return;
  }
  if (info.isFile()) {
    if (info.nlink !== 1) throw new CliHostProtocolError(`refusing to copy hard-linked file '${relative}'`);
    yield header({ path: relative, type: "file", mode: info.mode & 0o777, size: info.size });
    const input: ReadStream = createReadStream(absolute, { signal });
    try { for await (const chunk of input) yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); }
    finally { input.destroy(); }
    return;
  }
  if (info.isSymbolicLink()) {
    const target = await readlink(absolute);
    let resolved: string;
    try { resolved = await realpath(absolute); }
    catch (error) { throw new CliHostProtocolError(`refusing unresolved symlink '${relative}'`, { cause: error }); }
    if (!inside(root, resolved)) throw new CliHostProtocolError(`refusing escaping symlink '${relative}'`);
    if (unsafeCopyLinkTarget(relative, target)) throw new CliHostProtocolError(`refusing nonportable symlink '${relative}'`);
    yield header({ path: relative, type: "symlink", mode: info.mode & 0o777, target });
    return;
  }
  throw new CliHostProtocolError(`refusing special file '${relative}'`);
}

export async function stageCopyArchive(
  input: Readable,
  destination: string,
  options: { readonly overwrite: boolean; readonly signal?: AbortSignal },
  operations: CopyArchiveOperations = copyArchiveOperations
): Promise<StagedCopyArchive> {
  const target = path.resolve(destination);
  const parent = path.dirname(target);
  await mkdir(parent, { recursive: true });
  const staging = path.join(parent, `.dim-copy-${randomUUID()}`);
  const stage = path.join(staging, "payload");
  const backup = path.join(parent, `.dim-copy-backup-${randomUUID()}`);
  try {
    if (!options.overwrite && await exists(target)) throw new CliHostProtocolError(`copy destination '${destination}' already exists; use --overwrite`);
    await mkdir(staging, { mode: 0o700 });
    const reader = new CopyArchiveReader(input);
    await reader.magic();
    const seen = new Map<string, Entry["type"]>();
    const directoryModes: Array<{ readonly path: string; readonly mode: number }> = [];
    let first = true;
    for (;;) {
      options.signal?.throwIfAborted();
      const entry = await reader.entry();
      if (entry === undefined) break;
      validateEntry(entry, first, seen);
      first = false;
      const output = entry.path === "." ? stage : path.join(stage, ...entry.path.split("/"));
      if (entry.path !== ".") {
        const parentEntry = path.posix.dirname(entry.path);
        if (seen.get(parentEntry === "." ? "." : parentEntry) !== "directory") throw new CliHostProtocolError(`archive parent for '${entry.path}' is not a directory`);
      }
      if (entry.type === "directory") { await mkdir(output, { mode: 0o700 }); directoryModes.push({ path: output, mode: entry.mode }); }
      else if (entry.type === "symlink") await symlink(entry.target, output);
      else {
        await reader.file(output, entry.size, options.signal);
        await chmod(output, entry.mode);
      }
    }
    if (first) throw new CliHostProtocolError("copy archive is empty");
    await reader.end();
    for (const directory of directoryModes.reverse()) await chmod(directory.path, directory.mode);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
  let active = true;
  return {
    publish: async () => {
      if (!active) throw new CliHostProtocolError("copy archive staging is no longer active");
      options.signal?.throwIfAborted();
      let backedUp = false;
      if (await exists(target)) {
        if (!options.overwrite) throw new CliHostProtocolError(`copy destination '${destination}' already exists; use --overwrite`);
        await operations.rename(target, backup); backedUp = true;
      }
      try { options.signal?.throwIfAborted(); await operations.rename(stage, target); }
      catch (promotionError) {
        if (backedUp) {
          try { await operations.rename(backup, target); backedUp = false; }
          catch (restorationError) {
            active = false;
            await rm(staging, { recursive: true, force: true });
            throw new CliHostProtocolError(`copy promotion failed and the old destination backup was retained at '${backup}'`, {
              cause: new AggregateError([promotionError, restorationError])
            });
          }
        }
        throw promotionError;
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
      active = false;
      if (backedUp) {
        try { await (operations.remove?.(backup) ?? rm(backup, { recursive: true, force: true })); }
        catch (error) {
          throw new CliHostProtocolError(`copy was published but the old destination backup was retained at '${backup}'`, { cause: error });
        }
      }
    },
    discard: async () => { if (active) { active = false; await rm(staging, { recursive: true, force: true }); } }
  };
}

export async function extractCopyArchive(
  input: Readable,
  destination: string,
  options: { readonly overwrite: boolean; readonly signal?: AbortSignal },
  operations: CopyArchiveOperations = copyArchiveOperations
): Promise<void> {
  const staged = await stageCopyArchive(input, destination, options, operations);
  try { await staged.publish(); }
  catch (error) { await staged.discard(); throw error; }
}

export async function writeSingleFileArchive(input: Readable, output: Writable, signal?: AbortSignal): Promise<void> {
  const reader = new CopyArchiveReader(input);
  await reader.magic();
  const entry = await reader.entry();
  if (entry?.type !== "file" || entry.path !== ".") throw new CliHostProtocolError("standard output copy requires a regular-file source");
  await reader.stream(output, entry.size, signal);
  if (await reader.entry() !== undefined) throw new CliHostProtocolError("standard output copy received more than one archive entry");
  await reader.end();
}

function header(entry: Entry): Buffer {
  const encoded = Buffer.from(JSON.stringify(entry), "utf8");
  const length = Buffer.alloc(4); length.writeUInt32BE(encoded.length);
  return Buffer.concat([length, encoded]);
}

function validateEntry(entry: Entry, first: boolean, seen: Map<string, Entry["type"]>): void {
  if (first !== (entry.path === ".") || entry.path.includes("\\") || entry.path.startsWith("/")
    || (entry.path !== "." && entry.path.split("/").some((part) => !part || part === "." || part === ".."))) {
    throw new CliHostProtocolError(`unsafe copy archive path '${entry.path}'`);
  }
  if (seen.has(entry.path)) throw new CliHostProtocolError(`duplicate copy archive path '${entry.path}'`);
  if (entry.type === "symlink") {
    if (entry.path === "." || unsafeCopyLinkTarget(entry.path, entry.target)) {
      throw new CliHostProtocolError(`unsafe copy archive symlink '${entry.path}'`);
    }
  }
  seen.set(entry.path, entry.type);
}

async function safeStat(file: string, description: string) {
  try { return await lstat(file); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") throw new CliHostProtocolError(`${description} '${file}' does not exist`);
    throw error;
  }
}
async function exists(file: string): Promise<boolean> {
  try { await lstat(file); return true; }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return false; throw error; }
}
function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}
