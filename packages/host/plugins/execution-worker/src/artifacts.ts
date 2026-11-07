import { constants } from "node:fs";
import { mkdir, lstat, open, opendir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { executionArtifactLimits, executionArtifactSchema, executionArtifactManifestSchema, type ExecutionArtifactManifest, type ExecutionArtifact } from "@slop-lab/dim-contracts-execution";
import type { ExecutionResult } from "@slop-lab/dim-contracts-ci/aggregate";
import type { ExecutionWorkerClient, WorkerAssignment } from "./client.js";
export const jobArtifactsDirectory = "/workspace/.dim-ci-artifacts";
const digest = (bytes: Buffer) => "sha256:" + createHash("sha256").update(bytes).digest("hex");
/** Called after backend cleanup has stopped every untrusted runtime writer. */
export async function captureExecutionArtifacts(input: { root: string; pending: string; result: ExecutionResult }): Promise<ExecutionArtifactManifest> {
  await mkdir(input.pending, { mode: 0o700 });
  const captured: ExecutionArtifact[] = []; let total = 0, entries = 0;
  async function add(source: string, name: string, expected?: {bytes:string;sha256:string}) {
    const handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let bytes: Buffer;
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.nlink !== 1 || before.size > executionArtifactLimits.fileBytes || captured.length >= executionArtifactLimits.files
        || total + before.size > executionArtifactLimits.totalBytes) throw new Error("artifact bound or file type rejected");
      bytes = await handle.readFile(); const after = await handle.stat();
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.length !== before.size) throw new Error("artifact changed during capture");
    } finally { await handle.close(); }
    const sha256 = digest(bytes);
    if (expected && (String(bytes.length) !== expected.bytes || sha256 !== expected.sha256)) throw new Error("full execution log integrity mismatch");
    const id = createHash("sha256").update(name).digest("hex");
    const metadata=executionArtifactSchema.parse({id,name,bytes:bytes.length,sha256,mediaType:name.endsWith(".png")?"image/png":name.endsWith(".json")?"application/json":/\.(log|txt|md)$/.test(name)?"text/plain":"application/octet-stream"});
    const file = await open(join(input.pending,id), constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    total += bytes.length;
    captured.push(metadata);
  }
  async function visit(directory: string, relative: string, depth: number): Promise<void> {
    const info = await lstat(directory); if (!info.isDirectory() || info.isSymbolicLink() || depth > 16) throw new Error("artifact directory rejected");
    const dir = await opendir(directory);
    for await (const entry of dir) {
      if (++entries > 512 || entry.name.includes("\\") || /[\x00-\x1f\x7f]/.test(entry.name)) throw new Error("artifact directory bound exceeded");
      const name = relative ? relative+"/"+entry.name : entry.name, path = join(directory,entry.name), metadata = await lstat(path);
      if (metadata.isDirectory() && !metadata.isSymbolicLink()) await visit(path,name,depth+1);
      else if (metadata.isFile() && !metadata.isSymbolicLink()) await add(path,"files/"+name);
      else throw new Error("artifact must be a regular file");
    }
  }
  let error: string | undefined;
  try {
    for (const stream of ["stdout","stderr"] as const) {
      const path=join(input.root,"output",stream);
      try { await add(path,"logs/"+stream+".log",input.result[stream]); }
      catch (failure) {
        if (!(failure instanceof Error && "code" in failure && failure.code === "ENOENT") || input.result[stream].bytes !== "0") throw failure;
        const empty=join(input.pending,"empty-"+stream);await writeFile(empty,Buffer.alloc(0),{flag:"wx",mode:0o600});await add(empty,"logs/"+stream+".log",input.result[stream]);
      }
    }
    const directory=join(input.root,"workspace",".dim-ci-artifacts");
    let present=true;
    try {await lstat(directory);}catch(failure){if(failure instanceof Error && "code" in failure && failure.code === "ENOENT")present=false;else throw failure;}
    if(present)await visit(directory,"",0);
  } catch { error="artifact-capture-failed"; }
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
