import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, symlink, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ExecutionArtifactStore } from "../../../../packages/control-plane/plugins/execution-scheduler/src/artifacts.js";
import { executionArtifactManifestSchema } from "../../../../packages/contracts/execution/src/artifacts.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root,{recursive:true,force:true}))); });
async function fixture() { const root=await mkdtemp(join(tmpdir(),"dim-artifacts-"));roots.push(root);return {root,store:new ExecutionArtifactStore(join(root,"artifacts")),id:randomUUID()}; }
function input(bytes:Buffer,name="logs/stdout.log") { return {descriptorDigest:"sha256:"+"a".repeat(64),artifact:{id:createHash("sha256").update(name).digest("hex"),name,bytes:bytes.length,sha256:"sha256:"+createHash("sha256").update(bytes).digest("hex"),mediaType:"text/plain"},offset:0,base64:bytes.toString("base64")}; }
it("persists complete bounded bytes beyond diagnostics, retries chunks and survives store restart",async()=>{
 const {root,store,id}=await fixture(),bytes=Buffer.from("a".repeat(90000)+"AFTER64K"),chunk=input(bytes);
 await store.chunk(id,{...chunk,base64:bytes.subarray(0,1000).toString("base64")});
 await store.chunk(id,chunk);await store.chunk(id,chunk);
 const manifest={executionId:id,descriptorDigest:chunk.descriptorDigest,availability:"complete" as const,artifacts:[chunk.artifact]};
 await store.finalize(id,manifest);await store.finalize(id,manifest);
 const restarted=new ExecutionArtifactStore(join(root,"artifacts"));
 expect(await restarted.manifest(id)).toEqual(manifest);expect(await restarted.bytes(id,chunk.artifact.id)).toEqual(bytes);
 expect((await stat(join(root,"artifacts",id,chunk.artifact.id+".bin"))).mode&0o777).toBe(0o600);
});
it("rejects conflicting bytes, incomplete/digest-invalid manifests and immutable replacements",async()=>{
 const {store,id}=await fixture(),chunk=input(Buffer.from("hello"));await store.chunk(id,chunk);
 await expect(store.chunk(id,{...chunk,base64:Buffer.from("other").toString("base64")})).rejects.toThrow("conflict");
 await expect(store.finalize(id,{executionId:id,descriptorDigest:chunk.descriptorDigest,availability:"complete",artifacts:[{...chunk.artifact,sha256:"sha256:"+"b".repeat(64)}]})).rejects.toThrow();
 const manifest={executionId:id,descriptorDigest:chunk.descriptorDigest,availability:"complete",artifacts:[chunk.artifact]};await store.finalize(id,manifest);
 await expect(store.finalize(id,{...manifest,availability:"unavailable",error:"changed"})).rejects.toThrow("immutable");
});
it("denies traversal/symlink files and validates current ownership at finalization",async()=>{
 const {root,store,id}=await fixture(),chunk=input(Buffer.from("safe"));
 expect(executionArtifactManifestSchema.safeParse({executionId:id,descriptorDigest:chunk.descriptorDigest,availability:"complete",artifacts:[{...chunk.artifact,name:"../secret"}]}).success).toBe(false);
 await store.chunk(id,chunk);const file=join(root,"artifacts",id,chunk.artifact.id+".bin");await rm(file);await writeFile(join(root,"secret"),"secret");await symlink(join(root,"secret"),file);
 await expect(store.finalize(id,{executionId:id,descriptorDigest:chunk.descriptorDigest,availability:"complete",artifacts:[chunk.artifact]})).rejects.toThrow();
 const empty={executionId:id,descriptorDigest:chunk.descriptorDigest,availability:"complete",artifacts:[]};
 await expect(store.finalize(id,empty,()=>{throw Error("lease expired");})).rejects.toThrow("lease expired");expect(await store.manifest(id)).toBeUndefined();
});
