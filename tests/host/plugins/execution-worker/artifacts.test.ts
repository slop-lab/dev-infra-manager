import { mkdtemp,mkdir,readFile,rm,symlink,writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { expect,it } from "vitest";
import { NativeOutputCollector } from "../../../../packages/host/plugins/execution-worker/src/output.js";
import { captureExecutionArtifacts } from "../../../../packages/host/plugins/execution-worker/src/artifacts.js";
it("captures full bounded logs and binary opt-in files outside the runtime root before cleanup",async()=>{
 const base=await mkdtemp(join(tmpdir(),"dim-capture-"));try{
  const root=join(base,"runtime"),pending=join(base,"pending");await mkdir(root);await mkdir(join(root,"workspace"));await mkdir(join(root,"workspace/.dim-ci-artifacts"));
  const bytes=Buffer.from("x".repeat(90000)+"TAIL"),collector=new NativeOutputCollector(200000,()=>{},join(root,"output"));collector.stdout.write(bytes);const output=collector.result();
  const png=Buffer.from([137,80,78,71,13,10,26,10]);await writeFile(join(root,"workspace/.dim-ci-artifacts/image.png"),png);
  const manifest=await captureExecutionArtifacts({root,pending,result:{executionId:randomUUID(),descriptorDigest:"sha256:"+"a".repeat(64),cleanupComplete:true,startedAt:new Date(0).toISOString(),finishedAt:new Date(1).toISOString(),completion:{kind:"exited",exitCode:23},result:"failure",stdout:output.stdoutEvidence,stderr:output.stderrEvidence,logs:{stdout:{base64:bytes.subarray(0,65536).toString("base64"),truncated:true},stderr:{base64:"",truncated:false}}}});
  await rm(root,{recursive:true});expect(manifest.availability).toBe("complete");const log=manifest.artifacts.find(x=>x.name==="logs/stdout.log")!,image=manifest.artifacts.find(x=>x.name==="files/image.png")!;expect(await readFile(join(pending,log.id))).toEqual(bytes);expect(await readFile(join(pending,image.id))).toEqual(png);expect(image.mediaType).toBe("image/png");
 }finally{await rm(base,{recursive:true,force:true});}
});
it("rejects opt-in symlinks while preserving captured logs and explicit artifact unavailability",async()=>{
 const base=await mkdtemp(join(tmpdir(),"dim-capture-"));try{const root=join(base,"runtime");await mkdir(root);await mkdir(join(root,"workspace"));await mkdir(join(root,"workspace/.dim-ci-artifacts"));await writeFile(join(base,"secret"),"outside");await symlink(join(base,"secret"),join(root,"workspace/.dim-ci-artifacts/secret"));
 const output=new NativeOutputCollector(100,()=>{},join(root,"output")).result();const manifest=await captureExecutionArtifacts({root,pending:join(base,"pending"),result:{executionId:randomUUID(),descriptorDigest:"sha256:"+"a".repeat(64),cleanupComplete:true,startedAt:new Date(0).toISOString(),finishedAt:new Date(1).toISOString(),completion:{kind:"exited",exitCode:0},result:"success",stdout:output.stdoutEvidence,stderr:output.stderrEvidence,logs:{stdout:{base64:"",truncated:false},stderr:{base64:"",truncated:false}}}});expect(manifest.availability).toBe("unavailable");expect(manifest.artifacts.map(x=>x.name)).toEqual(["logs/stdout.log","logs/stderr.log"]);
 }finally{await rm(base,{recursive:true,force:true});}
});
