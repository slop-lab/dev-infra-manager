import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
const run=promisify(execFile);
const rootPackage=fileURLToPath(new URL("../../",import.meta.url));
const quote=(value:string)=>`'${value.replaceAll("'","'\\''")}'`;

test("published client has no host runtime and forwards commands to a separately installed optional host",async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),"dim-independent-client-"));
  const scope=path.join(directory,"node_modules/@slop-lab");await mkdir(scope,{recursive:true});
  try{
    for(const [name,source] of [["dim-cli","packages/cli/core/dist"],["dim-contracts-cli-host","packages/contracts/cli-host/dist"]])await cp(path.join(rootPackage,source!),path.join(scope,name!),{recursive:true});
    await cp(path.join(rootPackage,"packages/cli/core/node_modules/commander"),path.join(directory,"node_modules/commander"),{recursive:true,dereference:true});
    const metadata=JSON.parse(await readFile(path.join(scope,"dim-cli/package.json"),"utf8"));
    assert.deepEqual(Object.keys(metadata.dependencies).sort(),["@slop-lab/dim-contracts-cli-host","commander"]);
    await assert.rejects(stat(path.join(scope,"dim-host-core")),{code:"ENOENT"});
    const executable=path.join(scope,"dim-cli/cli.js"), env={...process.env,XDG_CONFIG_HOME:path.join(directory,"config"),DIM_HOST_EXECUTABLE:"/missing-host"};
    assert.deepEqual(JSON.parse((await run(process.execPath,[executable,"--host-protocol"],{env})).stdout),{protocol:"dim.cli-host",versions:[1]});
    await run(process.execPath,[executable,"host","add","remote","--ssh","developer@devbox"],{env});
    const bin=path.join(directory,"bin");await mkdir(bin);
    const peer=fileURLToPath(new URL("./fixtures/host-peer.ts",import.meta.url));
    await writeFile(path.join(bin,"ssh"),`#!/bin/sh\nshift 3\nexec /bin/sh -c "$1"\n`,{mode:0o700});
    await writeFile(path.join(bin,"dim"),`#!/bin/sh\nexec ${quote(process.execPath)} ${quote(peer)} "$@"\n`,{mode:0o700});
    const args=["control-plane","future-operation","a;$(printf injected)'\"","--future-flag"];
    const result=await run(process.execPath,[executable,"--host","remote",...args],{env:{...env,PATH:`${bin}:${process.env.PATH ?? ""}`}});
    assert.deepEqual(JSON.parse(result.stdout).request.input.args,args);
  }finally{await rm(directory,{recursive:true,force:true})}
});

test("published host requires optional control-plane administration only when its command is selected",async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),"dim-independent-host-"));
  const scope=path.join(directory,"node_modules/@slop-lab");await mkdir(scope,{recursive:true});
  try{
    for(const [name,source] of [["dim-host-core","packages/host/core/dist"],["dim-contracts-cli-host","packages/contracts/cli-host/dist"]])await cp(path.join(rootPackage,source!),path.join(scope,name!),{recursive:true});
    await cp(path.join(rootPackage,"packages/host/core/node_modules/commander"),path.join(directory,"node_modules/commander"),{recursive:true,dereference:true});
    const executable=path.join(scope,"dim-host-core/application/host-main.js");
    const options={cwd:directory,env:{...process.env,XDG_CONFIG_HOME:path.join(directory,"config"),DIM_STATE_ROOT:path.join(directory,"state"),DIM_PLUGIN_HOME:path.join(directory,"plugins")}};
    assert.deepEqual(JSON.parse((await run(process.execPath,[executable,"ls","--json"],options)).stdout),[]);
    await assert.rejects(run(process.execPath,[executable,"control-plane","--help"],options),(error:unknown)=>error instanceof Error&&"stderr" in error&&/not installed on this host/.test(String(error.stderr)));
  }finally{await rm(directory,{recursive:true,force:true})}
});
