import { constants } from "node:fs";
import { open, mkdir, lstat, readFile, writeFile, link, unlink } from "node:fs/promises";
import { join, dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { executionArtifactChunkSchema, executionArtifactManifestSchema, executionArtifactSchema, executionArtifactLimits, type ExecutionArtifactManifest } from "@slop-lab/dim-contracts-execution";
import { ExecutionConflictError } from "@slop-lab/dim-contracts-execution";

/** Private per-execution immutable bytes, independent of Git and SQLite payloads. */
export class ExecutionArtifactStore {
  readonly #root: string;
  readonly #locks = new Map<string, Promise<unknown>>();
  readonly #durableDirectories = new Set<string>();
  constructor(root: string) { this.#root = root; }
  async chunk(executionId: string, input: unknown, authorize: () => void = () => {}): Promise<void> {
    const value = executionArtifactChunkSchema.parse(input);
    await this.#serial(executionId, async () => {
      const directory = await this.#directory(executionId);
      const complete = await this.manifest(executionId);
      if (complete !== undefined) {
        const expected = complete.artifacts.find(x => x.id === value.artifact.id);
        if (complete.descriptorDigest !== value.descriptorDigest || JSON.stringify(expected) !== JSON.stringify(value.artifact)) throw new ExecutionConflictError("artifact is immutable");
      }
      const meta = join(directory, value.artifact.id + ".json");
      const record = JSON.stringify({ descriptorDigest: value.descriptorDigest, artifact: value.artifact });
      const { readdir } = await import("node:fs/promises");
      const records = (await readdir(directory)).filter(x => /^[0-9a-f]{64}\.json$/.test(x));
      let total = 0;
      for (const name of records) total += executionArtifactSchema.parse(JSON.parse(await readFile(join(directory, name), "utf8")).artifact).bytes;
      const already = records.includes(value.artifact.id + ".json");
      if (records.length + (already ? 0 : 1) > executionArtifactLimits.files || total + (already ? 0 : value.artifact.bytes) > executionArtifactLimits.totalBytes) throw new ExecutionConflictError("artifact job bound exceeded");
      authorize();
      await publishImmutable(meta,record,"artifact metadata conflicts");
      const file = join(directory, value.artifact.id + ".bin");
      try { await writeFile(file, Buffer.alloc(0), { flag: "wx", mode: 0o600 }); } catch (error) { if (!exists(error)) throw error; }
      const handle = await open(file, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const info = await handle.stat(), bytes = Buffer.from(value.base64, "base64");
        if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || value.offset + bytes.length > value.artifact.bytes || value.offset > info.size) throw new ExecutionConflictError("artifact chunk bounds mismatch");
        if (info.size > value.artifact.bytes) throw new ExecutionConflictError("artifact bytes exceed declaration");
        const overlap = Math.min(bytes.length, info.size - value.offset);
        if (overlap > 0) {
          const prior = Buffer.alloc(overlap); const read = await handle.read(prior, 0, overlap, value.offset);
          if (read.bytesRead !== overlap || !prior.equals(bytes.subarray(0, overlap))) throw new ExecutionConflictError("artifact chunk conflicts");
        }
        if (complete !== undefined && overlap !== bytes.length) throw new ExecutionConflictError("artifact is immutable");
        authorize();
        let written = overlap;
        while (written < bytes.length) { const next = await handle.write(bytes, written, bytes.length - written, value.offset + written); if (next.bytesWritten < 1) throw new Error("artifact write failed"); written += next.bytesWritten; }
        await handle.sync();
      } finally { await handle.close(); }
    });
  }
  async finalize(executionId: string, input: unknown, authorize: () => void = () => {}): Promise<void> {
    const manifest = executionArtifactManifestSchema.parse(input);
    if (manifest.executionId !== executionId) throw new ExecutionConflictError("artifact execution mismatch");
    await this.#serial(executionId, async () => {
      const directory = await this.#directory(executionId);
      for (const artifact of manifest.artifacts) {
        const meta = JSON.parse(await readFile(join(directory, artifact.id + ".json"), "utf8"));
        if (meta.descriptorDigest !== manifest.descriptorDigest || JSON.stringify(meta.artifact) !== JSON.stringify(artifact)) throw new ExecutionConflictError("artifact manifest conflicts");
        const bytes = await this.#bytes(directory, artifact.id);
        if (bytes.length !== artifact.bytes || digest(bytes) !== artifact.sha256) throw new ExecutionConflictError("artifact digest mismatch");
      }
      authorize();
      const text = JSON.stringify(manifest), file = join(directory, "manifest.json");
      await publishImmutable(file,text,"artifact manifest is immutable");
    });
  }
  async manifest(executionId: string): Promise<ExecutionArtifactManifest | undefined> {
    assertId(executionId);
    try { return executionArtifactManifestSchema.parse(JSON.parse(await readFile(join(this.#root, executionId, "manifest.json"), "utf8"))); }
    catch (error) { if (missing(error)) return undefined; throw error; }
  }
  async bytes(executionId: string, artifactId: string): Promise<Buffer | undefined> {
    if (!/^[0-9a-f]{64}$/.test(artifactId)) return undefined;
    const manifest = await this.manifest(executionId), artifact = manifest?.artifacts.find(x => x.id === artifactId);
    if (artifact === undefined) return undefined;
    const bytes = await this.#bytes(join(this.#root, executionId), artifactId);
    if (bytes.length !== artifact.bytes || digest(bytes) !== artifact.sha256) throw new ExecutionConflictError("stored artifact integrity failure");
    return bytes;
  }
  async #bytes(directory: string, id: string): Promise<Buffer> {
    const handle = await open(join(directory, id + ".bin"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try { const info = await handle.stat(); if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || info.size > executionArtifactLimits.fileBytes) throw new ExecutionConflictError("invalid stored artifact"); return await handle.readFile(); }
    finally { await handle.close(); }
  }
  async #directory(id: string): Promise<string> {
    assertId(id);
    for (const directory of [this.#root, join(this.#root, id)]) {
      await mkdir(directory, { mode: 0o700 }).catch(error => { if (!exists(error)) throw error; });
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) {
        throw new ExecutionConflictError("invalid artifact directory");
      }
      // File fsync cannot make its containing directory's name durable. Establish
      // the namespace on first use, including directories left by a prior process.
      const identity = `${info.dev}:${info.ino}`;
      if (!this.#durableDirectories.has(identity)) {
        const parent = await open(dirname(directory), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        try { await parent.sync(); } finally { await parent.close(); }
        this.#durableDirectories.add(identity);
      }
    }
    return join(this.#root, id);
  }
  async #serial<T>(id: string, action: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(id) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(action); this.#locks.set(id, current);
    try { return await current; } finally { if (this.#locks.get(id) === current) this.#locks.delete(id); }
  }
}
function assertId(id: string): void { if (!/^[0-9a-f-]{36}$/.test(id)) throw new ExecutionConflictError("invalid artifact execution ID"); }
function exists(error: unknown): boolean { return error instanceof Error && "code" in error && error.code === "EEXIST"; }
function missing(error: unknown): boolean { return error instanceof Error && "code" in error && error.code === "ENOENT"; }
function digest(bytes: Buffer): string { return "sha256:" + createHash("sha256").update(bytes).digest("hex"); }

async function publishImmutable(file: string, text: string, conflict: string): Promise<void> {
  const temporary=join(dirname(file),".artifact-write-"+randomUUID());
  const handle=await open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try {
    await handle.writeFile(text);await handle.sync();await handle.close();
    try {await link(temporary,file);} catch(error) {if(!exists(error)||await readFile(file,"utf8")!==text)throw new ExecutionConflictError(conflict);}
    const directory=await open(dirname(file),constants.O_RDONLY|constants.O_DIRECTORY);try{await directory.sync();}finally{await directory.close();}
  } finally {await handle.close().catch(()=>{});await unlink(temporary).catch(error=>{if(!missing(error))throw error;});}
}
