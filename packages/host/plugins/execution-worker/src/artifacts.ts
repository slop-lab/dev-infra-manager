import { constants } from "node:fs";
import { mkdir, lstat, open, opendir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { executionArtifactLimits, executionArtifactSchema, executionArtifactManifestSchema, type ExecutionArtifactManifest, type ExecutionArtifact } from "@slop-lab/dim-contracts-execution";
import type { ExecutionResult } from "@slop-lab/dim-contracts-ci/aggregate";
import type { ExecutionWorkerClient, WorkerAssignment } from "./client.js";
import { ArtifactHandoffError, type BackendArtifactSource } from "./artifact-source.js";
import { captureArchiveArtifacts } from "./artifact-archive.js";
export const jobArtifactsDirectory = "/workspace/.dim-ci-artifacts";
const digest = (bytes: Buffer) => "sha256:" + createHash("sha256").update(bytes).digest("hex");
type CaptureOperation = "source-open" | "source-stat" | "source-read" | "source-close" | "file-validation" | "file-integrity"
  | "directory-stat" | "directory-open" | "directory-read" | "directory-validation" | "pending-open" | "pending-write" | "pending-sync" | "pending-close";
const captureErrnos = ["EACCES", "EPERM", "ENOENT", "ELOOP", "ENOTDIR", "EIO", "EMFILE", "ENFILE", "ENOSPC", "EDQUOT", "EFBIG", "EINVAL", "EBADF", "EROFS"] as const;
class ArtifactCaptureError extends Error {
  constructor(operation: CaptureOperation, failure?: unknown) {
    const code = failure instanceof Error && "code" in failure ? failure.code : undefined;
    super(`artifact-capture-failed:${operation}:${captureErrnos.some(known => known === code) ? code : failure === undefined ? "rejected" : "unknown"}`, { cause: failure });
  }
}
async function captureOperation<T>(operation: CaptureOperation, action: () => Promise<T>): Promise<T> {
  try { return await action(); } catch (failure) { throw new ArtifactCaptureError(operation, failure); }
}
/** Called after backend cleanup has stopped every untrusted runtime writer. */
export async function captureExecutionArtifacts(input: { root: string; pending: string; result: ExecutionResult; artifactSource?: BackendArtifactSource; artifactNonce?: string }): Promise<ExecutionArtifactManifest> {
  await mkdir(input.pending, { mode: 0o700 });
  const captured: ExecutionArtifact[] = []; let total = 0, entries = 0;
  async function add(source: string, name: string, expected?: {bytes:string;sha256:string}) {
    const handle = await captureOperation("source-open", () => open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK));
    let bytes: Buffer;
    try {
      const before = await captureOperation("source-stat", () => handle.stat());
      if (!before.isFile() || before.nlink !== 1 || before.size > executionArtifactLimits.fileBytes || captured.length >= executionArtifactLimits.files
        || total + before.size > executionArtifactLimits.totalBytes) throw new ArtifactCaptureError("file-validation");
      bytes = await captureOperation("source-read", () => handle.readFile()); const after = await captureOperation("source-stat", () => handle.stat());
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.length !== before.size) throw new ArtifactCaptureError("file-integrity");
    } finally { await captureOperation("source-close", () => handle.close()); }
    const sha256 = digest(bytes);
    if (expected && (String(bytes.length) !== expected.bytes || sha256 !== expected.sha256)) throw new ArtifactCaptureError("file-integrity");
    const id = createHash("sha256").update(name).digest("hex");
    const metadata=executionArtifactSchema.parse({id,name,bytes:bytes.length,sha256,mediaType:name.endsWith(".png")?"image/png":name.endsWith(".json")?"application/json":/\.(log|txt|md)$/.test(name)?"text/plain":"application/octet-stream"});
    const file = await captureOperation("pending-open", () => open(join(input.pending,id), constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW, 0o600));
    try { await captureOperation("pending-write", () => file.writeFile(bytes)); await captureOperation("pending-sync", () => file.sync()); } finally { await captureOperation("pending-close", () => file.close()); }
    total += bytes.length;
    captured.push(metadata);
  }
  async function visit(directory: string, relative: string, depth: number): Promise<void> {
    const info = await captureOperation("directory-stat", () => lstat(directory)); if (!info.isDirectory() || info.isSymbolicLink() || depth > 16) throw new ArtifactCaptureError("directory-validation");
    const dir = await captureOperation("directory-open", () => opendir(directory));
    try { for await (const entry of dir) {
      if (++entries > 512 || entry.name.includes("\\") || /[\x00-\x1f\x7f]/.test(entry.name)) throw new ArtifactCaptureError("directory-validation");
      const name = relative ? relative+"/"+entry.name : entry.name, path = join(directory,entry.name), metadata = await captureOperation("directory-stat", () => lstat(path));
      if (metadata.isDirectory() && !metadata.isSymbolicLink()) await visit(path,name,depth+1);
      else if (metadata.isFile() && !metadata.isSymbolicLink()) await add(path,"files/"+name);
      else throw new ArtifactCaptureError("file-validation");
    } } catch (failure) { if (failure instanceof ArtifactCaptureError) throw failure; throw new ArtifactCaptureError("directory-read", failure); }
  }
  let error: string | undefined;
  try {
    for (const stream of ["stdout","stderr"] as const) {
      const path=join(input.root,"output",stream);
      try { await add(path,"logs/"+stream+".log",input.result[stream]); }
      catch (failure) {
        if (!(failure instanceof ArtifactCaptureError && failure.cause instanceof Error && "code" in failure.cause && failure.cause.code === "ENOENT") || input.result[stream].bytes !== "0") throw failure;
        const empty=join(input.pending,"empty-"+stream);await writeFile(empty,Buffer.alloc(0),{flag:"wx",mode:0o600});await add(empty,"logs/"+stream+".log",input.result[stream]);
      }
    }
    if (input.artifactSource !== undefined) {
      if (input.artifactSource.nonce !== input.artifactNonce) throw new ArtifactHandoffError();
      switch (input.artifactSource.kind) {
        case "archive": captured.push(...await captureArchiveArtifacts({ root: input.root, pending: input.pending, source: input.artifactSource }, captured)); break;
        case "unavailable": error="artifact-capture-failed:"+input.artifactSource.error; break;
        default: input.artifactSource satisfies never;
      }
    } else {
    const directory=join(input.root,"workspace",".dim-ci-artifacts");
    let present=true;
    try {await lstat(directory);}catch(failure){if(failure instanceof Error && "code" in failure && failure.code === "ENOENT")present=false;else throw new ArtifactCaptureError("directory-stat",failure);}
    if(present)await visit(directory,"",0);
    }
  } catch (failure) { error=failure instanceof ArtifactCaptureError?failure.message:failure instanceof ArtifactHandoffError?"artifact-capture-failed:archive:rejected":"artifact-capture-failed"; }
  const manifest=executionArtifactManifestSchema.parse({executionId:input.result.executionId,descriptorDigest:input.result.descriptorDigest,
    availability:error?"unavailable":"complete",...(error?{error}:{}),artifacts:captured});
  const file=await open(join(input.pending,"manifest.json"),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try {await file.writeFile(JSON.stringify(manifest));await file.sync();} finally {await file.close();}
  const dir=await open(input.pending,constants.O_RDONLY|constants.O_DIRECTORY);try {await dir.sync();}finally{await dir.close();}
  return manifest;
}
export async function uploadExecutionArtifacts(client: ExecutionWorkerClient, assignment: WorkerAssignment, pending: string, signal: AbortSignal): Promise<void> {
  const manifest=executionArtifactManifestSchema.parse(JSON.parse(await readFile(join(pending,"manifest.json"),"utf8")));
  if (manifest.executionId!==assignment.id || manifest.descriptorDigest!==assignment.grant?.descriptorDigest) throw new Error("pending artifacts do not match assignment");
  for (const artifact of manifest.artifacts) {
    const handle=await open(join(pending,artifact.id),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    let bytes:Buffer;
    try {const info=await handle.stat();if(!info.isFile()||info.nlink!==1||info.uid!==process.getuid?.()||info.size!==artifact.bytes)throw Error("pending artifact invalid");bytes=await handle.readFile();}finally{await handle.close();}
    if(digest(bytes)!==artifact.sha256)throw Error("pending artifact integrity mismatch");
    for(let offset=0;offset<Math.max(1,bytes.length);offset+=executionArtifactLimits.chunkBytes) {
      await client.artifactChunk(assignment,{descriptorDigest:manifest.descriptorDigest,artifact,offset,base64:bytes.subarray(offset,offset+executionArtifactLimits.chunkBytes).toString("base64")},signal);
    }
  }
  await client.finalizeArtifacts(assignment,manifest,signal);
}
