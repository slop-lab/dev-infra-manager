import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { HostContextStore } from "../../packages/cli/core/src/host-context.js";

const cli = fileURLToPath(new URL("../../packages/cli/core/src/cli.ts", import.meta.url));
const noHostRuntime = `data:text/javascript,${encodeURIComponent('import {registerHooks} from "node:module";registerHooks({resolve(s,c,n){if(s.startsWith("@slop-lab/dim-host-core")||s.startsWith("@slop-lab/dim-control-plane-"))throw Error("CLI must not import a host runtime");return n(s,c)}})')}`;
const peer = fileURLToPath(new URL("./fixtures/host-peer.ts", import.meta.url));
const shell = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

async function fixture(action: (run: (args: string[], extra?: Record<string,string>) => Promise<{status:number|null;stdout:string;stderr:string}>, root: string) => Promise<void>) {
  const root=await mkdtemp(path.join(tmpdir(),"dim-stable-client-"));
  await mkdir(path.join(root,"bin"));
  const endpoint=path.join(root,"bin/dim-host");
  await writeFile(endpoint,`#!/bin/sh\nexec ${shell(process.execPath)} ${shell(peer)} "$@"\n`,{mode:0o700});
  await writeFile(path.join(root,"bin/ssh"),`#!/bin/sh\nshift 3\nexec /bin/sh -c "$1"\n`,{mode:0o700});
  await writeFile(path.join(root,"bin/dim"),`#!/bin/sh\nexec ${shell(process.execPath)} ${shell(peer)} "$@"\n`,{mode:0o700});
  const run=async(args:string[],extra:Record<string,string>={})=>{
    const child=spawn(process.execPath,["--disable-warning=DEP0205","--conditions=dim-source","--import",import.meta.resolve("tsx"),"--import",noHostRuntime,cli,...args],{env:{...process.env,XDG_CONFIG_HOME:path.join(root,"config"),DIM_HOST_EXECUTABLE:endpoint,PATH:`${path.join(root,"bin")}:${process.env.PATH ?? ""}`,...extra},stdio:["pipe","pipe","pipe"]});
    let stdout="",stderr="";child.stdout.on("data",chunk=>{stdout+=String(chunk)});child.stderr.on("data",chunk=>{stderr+=String(chunk)});child.stdin.end();
    const status=await new Promise<number|null>((resolve,reject)=>{child.once("error",reject);child.once("close",resolve)});
    return {status,stdout,stderr};
  };
  try{await action(run,root)}finally{await rm(root,{recursive:true,force:true})}
}

test("forwards future host commands, flags, help and literal arguments without interpreting them",async()=>{
  await fixture(async(run)=>{
    for(const args of [["future-feature","--brand-new-option","value"],["create","--help"],["--help"],["controller","restart"],["workspace","recreate","dev"],["future","--","--host","literal",""],[]]){
      const result=await run(args);assert.equal(result.status,0,result.stderr);
      assert.deepEqual(JSON.parse(result.stdout),{request:{protocol:"dim.cli-host",version:1,operation:"command",input:{args,terminal:false}}});
    }
  });
});
test("negotiates wire versions independently of host releases and stops before unsupported commands",async()=>{
  await fixture(async(run)=>{
    const future=await run(["new-feature"],{DIM_TEST_VERSIONS:"[7,1]"});assert.equal(future.status,0,future.stderr);
    const incompatible=await run(["must-not-run"],{DIM_TEST_VERSIONS:"[2]"});assert.equal(incompatible.status,2);assert.equal(incompatible.stdout,"");assert.match(incompatible.stderr,/does not support.*version 1/);
  });
});
test("client context management requires no host and selected SSH contexts receive raw command arguments",async()=>{
  await fixture(async(run,root)=>{
    assert.equal((await run(["host","add","remote","--ssh","fixture-target"],{DIM_HOST_EXECUTABLE:"/missing-host"})).status,0);
    assert.equal((await run(["host","use","remote"])).status,0);
    const result=await run(["new-command","--new-flag"]);assert.equal(result.status,0,result.stderr);assert.deepEqual(JSON.parse(result.stdout).request.input.args,["new-command","--new-flag"]);
    const override=await run(["new-command","--host=local","--help"]);assert.equal(override.status,0,override.stderr);assert.deepEqual(JSON.parse(override.stdout).request.input.args,["new-command","--help"]);
    assert.equal((await new HostContextStore(path.join(root,"config")).resolve()).name,"remote");
  });
});
test("installation protocol probe and client version work without contacting a host",async()=>{
  await fixture(async(run)=>{
    const env={DIM_HOST_EXECUTABLE:"/missing-host"};
    const probe=await run(["--host-protocol"],env);assert.equal(probe.status,0);assert.deepEqual(JSON.parse(probe.stdout),{protocol:"dim.cli-host",versions:[1]});
    const version=await run(["--version"],env);assert.equal(version.status,0);assert.equal(version.stdout.trim(),"0.10.0");
    for(const option of ["--help","-h"]){const help=await run(["cp",option],env);assert.equal(help.status,0,help.stderr);assert.match(help.stdout,/Usage: dim cp/);assert.match(help.stdout,/WORKSPACE:PATH/);}
  });
});

test("copy owns operator-local paths instead of forwarding them as selected-host paths",async()=>{
  await fixture(async(run,root)=>{
    const missing=path.join(root,"operator-only","missing.txt");
    const result=await run(["cp",missing,"dev:/workspace/copied.txt"]);
    assert.equal(result.status,2);
    assert.equal(result.stdout,"");
    assert.match(result.stderr,/local copy source.*does not exist/i);
    const target=path.join(root,"target");const link=path.join(root,"source-link");await writeFile(target,"data");await import("node:fs/promises").then(({symlink})=>symlink(target,link));
    const linked=await run(["cp",link,"dev:/workspace/copied.txt"],{DIM_HOST_EXECUTABLE:"/missing-host"});
    assert.equal(linked.status,2);assert.match(linked.stderr,/symlink.*recursive directory source/i);
  });
});

test("keeps the client's conventional signal exit status while cancelling the host stream",async()=>{
  await fixture(async(_run,root)=>{
    for(const [signal,status] of [["SIGINT",130],["SIGTERM",143],["SIGHUP",129]] as const){
      const child=spawn(process.execPath,["--disable-warning=DEP0205","--conditions=dim-source","--import",import.meta.resolve("tsx"),cli,"wait"],{env:{...process.env,XDG_CONFIG_HOME:path.join(root,"config"),DIM_HOST_EXECUTABLE:path.join(root,"bin/dim-host")},stdio:["ignore","pipe","pipe"]});
      const closed=once(child,"close");
      await once(child.stdout,"data");child.kill(signal);
      assert.equal((await closed)[0],status);
    }
  });
});
