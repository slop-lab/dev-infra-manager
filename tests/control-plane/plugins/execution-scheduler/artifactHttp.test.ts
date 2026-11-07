import { randomBytes, randomUUID, createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { configuredExecutionServer } from "../../../../packages/control-plane/plugins/execution-scheduler/src/service.js";
import { executionWorkerClient } from "../../../../packages/host/plugins/execution-worker/src/client.js";
import { createExecutionQueryClient } from "../../../../packages/service-clients/execution/src/query.js";
import { event, grant, slot } from "../../../contracts/ci/executionFixture.js";
it("fences artifact uploads by worker/slot/lease/generation/digest and downloads exact persisted bytes after restart",async()=>{
 const root=await mkdtemp(join(tmpdir(),"dim-artifact-http-")),generationId="a".repeat(64),activationToken=randomBytes(32).toString("base64url");
 const credential=(username:string,n:number)=>({username,password:Buffer.alloc(32,n).toString("base64url")});
 const workerToken=Buffer.alloc(32,2).toString("base64url"),query=credential("query",4);let now=10000;
 const config={schemaVersion:1 as const,claimLeaseMilliseconds:30000,credentials:{operator:credential("operator",1),webhook:credential("webhook",3),query},nativeGit:{endpoint:"http://127.0.0.1:9",grantIssuer:credential("issuer",5),candidateReader:credential("reader",6),resultReporter:credential("reporter",7)},workers:[{id:"worker-a",token:workerToken,slots:[{id:slot.id,runtime:"container" as const,profile:slot.profile}]}]};
 let service:ReturnType<typeof configuredExecutionServer>|undefined;
 async function start(){
  const active=configuredExecutionServer({config,stateDirectory:root,readinessToken:randomBytes(32).toString("base64url"),activationToken,expectedGenerationId:generationId,now:()=>now,
   source:{async authorize(a){return grant(a);},async candidate(){throw Error("not requested");},async publish(){}}});service=active;
  await new Promise<void>(resolve=>active.server.listen(0,"127.0.0.1",resolve));const address=active.server.address();if(!address||typeof address==="string")throw Error("listener absent");
  const endpoint="http://127.0.0.1:"+address.port;await fetch(endpoint+"/v1/activation",{method:"POST",headers:{authorization:"Bearer "+activationToken},body:JSON.stringify({schemaVersion:1,generationId})});return {active,endpoint};
 }
 try{
  const first=await start(),queued=first.active.store.enqueue(event());
  const client=executionWorkerClient({endpoint:first.endpoint,workerId:"worker-a",token:workerToken,slotId:slot.id,generationId});
  const assignment=await client.claim(randomUUID());if(!assignment||!assignment.grant)throw Error("missing assignment");
  const bytes=Buffer.from("x".repeat(700000)+"FULL_LOG_MARKER"),artifact={id:"b".repeat(64),name:"logs/stdout.log",bytes:bytes.length,sha256:"sha256:"+createHash("sha256").update(bytes).digest("hex"),mediaType:"text/plain"};
  const headers={authorization:"Basic "+Buffer.from("worker-a:"+workerToken).toString("base64"),"x-dim-generation-id":generationId,"content-type":"application/json"};
  const post=(overrides:Record<string,unknown>,selectedHeaders=headers)=>fetch(first.endpoint+"/v1/executions/"+queued.id+"/artifacts",{method:"POST",headers:selectedHeaders,body:JSON.stringify({slotId:slot.id,leaseToken:assignment.leaseToken,artifact:{descriptorDigest:assignment.grant!.descriptorDigest,artifact,offset:0,base64:bytes.subarray(0,100).toString("base64")},...overrides})});
  expect((await post({leaseToken:"bad".repeat(16)})).status).toBe(409);
  expect((await post({slotId:"other-slot"})).status).toBe(409);
  expect((await post({}, {...headers,"x-dim-generation-id":"c".repeat(64)})).status).toBe(409);
  expect((await post({artifact:{descriptorDigest:"sha256:"+"c".repeat(64),artifact,offset:0,base64:""}})).status).toBe(409);
  for(let offset=0;offset<bytes.length;offset+=256*1024)await client.artifactChunk(assignment,{descriptorDigest:assignment.grant.descriptorDigest,artifact,offset,base64:bytes.subarray(offset,offset+256*1024).toString("base64")});
  const manifest={executionId:queued.id,descriptorDigest:assignment.grant.descriptorDigest,availability:"complete",artifacts:[artifact]};await client.finalizeArtifacts(assignment,manifest);
  const queryClient=createExecutionQueryClient({schemaVersion:1,role:"query",endpoint:first.endpoint,generationId,credential:query});
  expect((await queryClient.byEvent(queued.event.eventId)).jobs[0]).toMatchObject({job:{id:queued.id,eventId:queued.event.eventId},descriptorDigest:assignment.grant.descriptorDigest});
  expect(await queryClient.artifact(queued.id,artifact.id)).toEqual(bytes);
  expect((await fetch(first.endpoint+"/v1/jobs/"+queued.id+"/artifacts")).status).toBe(401);
  now+=40000;expect((await post({})).status).toBe(409);
  await first.active.close();service=undefined;
  const second=await start(),restarted=createExecutionQueryClient({schemaVersion:1,role:"query",endpoint:second.endpoint,generationId,credential:query});
  expect(await restarted.artifacts(queued.id)).toEqual(manifest);expect(await restarted.artifact(queued.id,artifact.id)).toEqual(bytes);
 }finally{await service?.close();await rm(root,{recursive:true,force:true});}
});
