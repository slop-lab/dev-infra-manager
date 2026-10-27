import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:net";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { createCopyArchive, extractCopyArchive } from "../../packages/cli/core/src/copy-archive.js";
import { CopyArchiveReader, copyArchiveMagic } from "../../packages/cli/core/src/copy-archive-reader.js";

async function root(): Promise<string> { return mkdtemp(path.join(tmpdir(), "dim-copy-archive-")); }

test("recursive copy preserves bytes, executable mode, and contained symlinks", async () => {
  const temporary = await root();
  try {
    const source = path.join(temporary, "source");
    const destination = path.join(temporary, "destination");
    await mkdir(path.join(source, "nested"), { recursive: true });
    await writeFile(path.join(source, "nested", "binary"), Buffer.from([0, 255, 10]), { mode: 0o750 });
    await chmod(path.join(source, "nested", "binary"), 0o750);
    await symlink("nested/binary", path.join(source, "link"));
    await extractCopyArchive(createCopyArchive(source, true), destination, { overwrite: false });
    assert.deepEqual(await readFile(path.join(destination, "nested", "binary")), Buffer.from([0, 255, 10]));
    assert.equal((await lstat(path.join(destination, "nested", "binary"))).mode & 0o777, 0o750);
    assert.equal(await readlink(path.join(destination, "link")), "nested/binary");
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test("overwrite is explicit and replaces a longer file without retaining trailing bytes", async () => {
  const temporary = await root();
  try {
    const source = path.join(temporary, "source");
    const destination = path.join(temporary, "destination");
    await writeFile(source, "new"); await writeFile(destination, "old trailing bytes");
    await assert.rejects(extractCopyArchive(createCopyArchive(source, false), destination, { overwrite: false }), /--overwrite/);
    assert.equal(await readFile(destination, "utf8"), "old trailing bytes");
    await extractCopyArchive(createCopyArchive(source, false), destination, { overwrite: true });
    assert.equal(await readFile(destination, "utf8"), "new");
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test("packing rejects escaping links, hard links, special files, and directories without recursive", async () => {
  const temporary = await root();
  try {
    const directory = path.join(temporary, "source"); await mkdir(directory);
    await writeFile(path.join(directory, "file"), "data");
    await assert.rejects(consume(createCopyArchive(directory, false)), /--recursive/);
    await symlink("../outside", path.join(directory, "escape"));
    await assert.rejects(consume(createCopyArchive(directory, true)), /escaping|unresolved symlink/);
    await rm(path.join(directory, "escape"));
    await link(path.join(directory, "file"), path.join(directory, "hard"));
    await assert.rejects(consume(createCopyArchive(directory, true)), /hard-linked/);
    await rm(path.join(directory, "hard"));
    const socket = path.join(directory, "socket");
    const server = createServer(); server.listen(socket); await once(server, "listening");
    try { await assert.rejects(consume(createCopyArchive(directory, true)), /special file/); }
    finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test("failed overwrite promotion retains the old destination backup when restoration also fails", async () => {
  const temporary = await root();
  try {
    const source = path.join(temporary, "source"); const destination = path.join(temporary, "destination");
    await writeFile(source, "new"); await writeFile(destination, "old");
    const real = await import("node:fs/promises");
    await assert.rejects(extractCopyArchive(createCopyArchive(source, false), destination, { overwrite: true }, {
      rename: async (from, to) => {
        if (path.basename(from) === "payload") throw new Error("promotion failed");
        if (path.basename(from).startsWith(".dim-copy-backup-")) throw new Error("restoration failed");
        await real.rename(from, to);
      }
    }), /backup was retained/);
    const backup = (await real.readdir(temporary)).find((name) => name.startsWith(".dim-copy-backup-"));
    assert.ok(backup); assert.equal(await readFile(path.join(temporary, backup), "utf8"), "old");
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test("cancellation between backup and publication restores the original destination", async () => {
  const temporary = await root(), abort = new AbortController();
  const source = path.join(temporary, "source"), destination = path.join(temporary, "destination");
  try {
    await writeFile(source, "new"); await writeFile(destination, "old");
    const real = await import("node:fs/promises");
    await assert.rejects(extractCopyArchive(createCopyArchive(source, false), destination, { overwrite: true, signal: abort.signal }, {
      rename: async (from, to) => { await real.rename(from, to); if (from === destination) abort.abort(); }
    }), { name: "AbortError" });
    assert.equal(await readFile(destination, "utf8"), "old");
    assert.deepEqual((await readdir(temporary)).filter((name) => name.startsWith(".dim-copy")), []);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test("published destination reports and retains an old backup when backup cleanup fails", async () => {
  const temporary = await root();
  try {
    const source = path.join(temporary, "source"); const destination = path.join(temporary, "destination");
    await writeFile(source, "new"); await writeFile(destination, "old");
    const real = await import("node:fs/promises");
    await assert.rejects(extractCopyArchive(createCopyArchive(source, false), destination, { overwrite: true }, {
      rename: real.rename,
      remove: async () => { throw new Error("backup cleanup failed"); }
    }), /published.*backup was retained/);
    assert.equal(await readFile(destination, "utf8"), "new");
    const backup = (await readdir(temporary)).find((name) => name.startsWith(".dim-copy-backup-"));
    assert.ok(backup); assert.equal(await readFile(path.join(temporary, backup), "utf8"), "old");
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test("staging stays private until archive directory modes are published", async () => {
  const temporary = await root();
  try {
    const destination = path.join(temporary, "destination"); let stagingMode: number | undefined;
    const real = await import("node:fs/promises");
    await extractCopyArchive(archive([{ path: ".", type: "directory", mode: 0o777 }]), destination, { overwrite: false }, {
      rename: async (from, to) => {
        if (path.basename(from) === "payload") stagingMode = (await lstat(path.dirname(from))).mode & 0o777;
        await real.rename(from, to);
      }
    });
    assert.equal(stagingMode, 0o700); assert.equal((await lstat(destination)).mode & 0o777, 0o777);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test("archive framing rejects trailing bytes and bounded entry resources before writing", async () => {
  const temporary = await root();
  try {
    const trailing = Buffer.concat([archiveBuffer([{ path: ".", type: "file", mode: 0o600, size: 0 }]), Buffer.from([1])]);
    await assert.rejects(extractCopyArchive(Readable.from([trailing]), path.join(temporary, "trailing"), { overwrite: false }), /trailing data/);
    await assert.rejects(extractCopyArchive(archive([{ path: ".", type: "file", mode: 0o600, size: 64 * 1024 * 1024 * 1024 + 1 }]), path.join(temporary, "payload"), { overwrite: false }), /payload exceeds/);
    await assert.rejects(extractCopyArchive(archive([{ path: ".", type: "directory", mode: 0o700 }, { path: "x".repeat(4097), type: "file", mode: 0o600, size: 0 }]), path.join(temporary, "path"), { overwrite: false }), /invalid copy archive entry/);
    const oversized = Buffer.alloc(4); oversized.writeUInt32BE(64 * 1024 + 1);
    await assert.rejects(extractCopyArchive(Readable.from([Buffer.from("DIMCP1\0", "ascii"), oversized]), path.join(temporary, "header"), { overwrite: false }), /header is too large/);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test("archive reader bounds entry count before filesystem extraction", async () => {
  const encoded = Buffer.from(JSON.stringify({ path: "file", type: "file", mode: 0o600, size: 0 }));
  const length = Buffer.alloc(4); length.writeUInt32BE(encoded.length);
  const frame = Buffer.concat([length, encoded]);
  const reader = new CopyArchiveReader(Readable.from([copyArchiveMagic, ...Array<Buffer>(100_001).fill(frame), Buffer.alloc(4)]));
  await reader.magic();
  for (let index = 0; index < 100_000; index++) assert.ok(await reader.entry());
  await assert.rejects(reader.entry(), /too many entries/);
});

test("archive symlinks reject Windows, UNC, and backslash target forms", async () => {
  const temporary = await root();
  try {
    for (const [index, target] of ["C:/outside", "C:\\outside", "\\\\server\\share", "//server/share", "..\\outside", "nested\\file"].entries()) {
      await assert.rejects(extractCopyArchive(archive([
        { path: ".", type: "directory", mode: 0o700 }, { path: "link", type: "symlink", mode: 0o777, target }
      ]), path.join(temporary, `link-${index}`), { overwrite: false }), /unsafe copy archive symlink/);
    }
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test("extraction rejects traversal, absolute, escaping symlink, hardlink, and duplicate entries", async () => {
  const temporary = await root();
  try {
    for (const entries of [
      [{ path: "../escape", type: "file", mode: 0o600, size: 0 }],
      [{ path: "/absolute", type: "file", mode: 0o600, size: 0 }],
      [{ path: ".", type: "directory", mode: 0o700 }, { path: "escape", type: "symlink", mode: 0o777, target: "../outside" }],
      [{ path: ".", type: "hardlink", mode: 0o600, target: "other" }],
      [{ path: ".", type: "directory", mode: 0o700 }, { path: "file", type: "file", mode: 0o600, size: 0 }, { path: "file", type: "file", mode: 0o600, size: 0 }]
    ]) {
      await assert.rejects(extractCopyArchive(archive(entries), path.join(temporary, `output-${Math.random()}`), { overwrite: false }), /unsafe|unsupported|duplicate/);
    }
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

async function consume(input: Readable): Promise<void> { for await (const _chunk of input) continue; }
function archive(entries: readonly Record<string, unknown>[]): Readable {
  return Readable.from([archiveBuffer(entries)]);
}
function archiveBuffer(entries: readonly Record<string, unknown>[]): Buffer {
  const chunks: Buffer[] = [Buffer.from("DIMCP1\0", "ascii")];
  for (const entry of entries) {
    const encoded = Buffer.from(JSON.stringify(entry)); const length = Buffer.alloc(4); length.writeUInt32BE(encoded.length);
    chunks.push(length, encoded);
  }
  chunks.push(Buffer.alloc(4));
  return Buffer.concat(chunks);
}
