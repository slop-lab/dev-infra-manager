import { spawnSync } from "node:child_process";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const artifactUrl = pathToFileURL(resolve(import.meta.dirname, "../../.dim/qemu-service-artifacts.mjs")).href;
const roots: string[] = [];

async function runCase(stage: string, collision = false) {
  const root = await mkdtemp(resolve(tmpdir(), "dim-qemu-owner-transaction-test-"));
  roots.push(root);
  const ownerPath = resolve(root, "service-owner.json");
  const loader = resolve(root, "loader.mjs");
  const wrapper = resolve(root, "fs-wrapper.mjs");
  const runner = resolve(root, "runner.mjs");
  if (collision) await writeFile(ownerPath, "collision\n");
  await writeFile(loader, `import { pathToFileURL } from "node:url";
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "node:fs/promises" && context.parentURL?.startsWith(${JSON.stringify(artifactUrl)}))
    return { shortCircuit: true, url: pathToFileURL(process.env.DIM_TEST_FS_WRAPPER).href };
  return nextResolve(specifier, context);
}`);
  await writeFile(wrapper, `import * as fs from "node:fs/promises";
 export const link=fs.link;
 export async function rename(source,destination){if(process.env.DIM_TEST_STAGE==="rollback"&&destination.includes("service-owner.json.removing-")){const value=await fs.lstat(source,{bigint:true});await fs.writeFile(process.env.DIM_TEST_QUARANTINE_IDENTITY,JSON.stringify({device:value.dev.toString(),inode:value.ino.toString()}))}return fs.rename(source,destination)}
let directorySync=0;
let ownerReplaced=false;
export async function lstat(path,...args){
  const stats=await fs.lstat(path,...args);
  if(process.env.DIM_TEST_STAGE==="owner-replaced"&&path===process.env.DIM_TEST_OWNER&&!ownerReplaced){ownerReplaced=true;const foreign=path+".foreign";await fs.writeFile(foreign,"replacement\\n");await fs.rename(foreign,path);}
  return stats;
}
export async function open(path,...args){
  const handle=await fs.open(path,...args);
  if(path===process.env.DIM_TEST_ROOT){return {sync:async()=>{directorySync+=1;if((process.env.DIM_TEST_STAGE==="sync"||process.env.DIM_TEST_STAGE==="rollback"||process.env.DIM_TEST_STAGE==="owner-replaced")&&directorySync===1)throw new Error("PRIMARY_SYNC");if(process.env.DIM_TEST_STAGE==="rollback-sync"&&(directorySync===1||directorySync===3))throw new Error(directorySync===1?"PRIMARY_SYNC":"ROLLBACK_SYNC")},close:()=>handle.close()}}
  return new Proxy(handle,{get(target,key){if(key==="close"&&process.env.DIM_TEST_STAGE==="close")return async()=>{await target.close();throw new Error("CLOSE")};const value=target[key];return typeof value==="function"?value.bind(target):value}})
}
export async function rm(path,...args){
  if(process.env.DIM_TEST_STAGE==="temp"&&path.includes(".service-owner.json."))throw new Error("TEMP_UNLINK");
  if(process.env.DIM_TEST_STAGE==="rollback"&&path.includes("service-owner.json.removing-"))throw new Error("ROLLBACK");
  return fs.rm(path,...args)
}`);
   await writeFile(runner, `import { lstat,readdir,readFile } from "node:fs/promises";
import { publishOwner } from ${JSON.stringify(artifactUrl)};
const file={device:"0",inode:"1",path:"/bin/sh"};
const record={argv:["node"],cwd:{...file,path:process.env.DIM_TEST_ROOT},executable:file,pid:"1",pidNamespace:{device:"0",inode:"2"},schema:2,socket:{device:"0",inode:"1"},startTicks:"1"};
try{await publishOwner(process.env.DIM_TEST_OWNER,record)}
catch(error){const errors=error instanceof AggregateError?error.errors:[error];process.stdout.write(JSON.stringify(errors.map(value=>value.message)))}
const names=await readdir(process.env.DIM_TEST_ROOT);const removing=names.find(name=>name.includes("service-owner.json.removing-"));const removingPath=process.env.DIM_TEST_ROOT+"/"+removing;const stats=removing?await lstat(removingPath,{bigint:true}):null;process.stderr.write(JSON.stringify({expected:JSON.stringify(record)+"\\n",names,owner:names.includes("service-owner.json")?await readFile(process.env.DIM_TEST_OWNER,"utf8"):null,removing:removing?await readFile(removingPath,"utf8"):null,removingIdentity:stats?{device:stats.dev.toString(),inode:stats.ino.toString()}:null,sourceIdentity:removing?JSON.parse(await readFile(process.env.DIM_TEST_QUARANTINE_IDENTITY,"utf8")):null}));`);
  const result = spawnSync(process.execPath, ["--experimental-loader", loader, runner], {
    encoding: "utf8",
    env: { ...process.env, DIM_TEST_FS_WRAPPER: wrapper, DIM_TEST_OWNER: ownerPath,
      DIM_TEST_ROOT: root, DIM_TEST_STAGE: stage, NODE_NO_WARNINGS: "1",
      DIM_TEST_QUARANTINE_IDENTITY: resolve(root, "quarantine-identity.json") },
  });
  const errors: unknown = JSON.parse(result.stdout || "[]");
  const state: unknown = JSON.parse(result.stderr);
  return { errors, state };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("QEMU owner publication transaction", () => {
  it.each([
    ["sync", ["PRIMARY_SYNC"], false],
    ["temp", ["TEMP_UNLINK"], false],
    ["close", ["CLOSE"], false],
    ["rollback", ["PRIMARY_SYNC", "ROLLBACK"], false],
    ["rollback-sync", ["PRIMARY_SYNC", "ROLLBACK_SYNC"], false],
  ] as const)("rolls back exact owner after %s failure", async (stage, expectedErrors, ownerSurvives) => {
    const result = await runCase(stage === "rollback" ? "rollback" : stage);
    if (typeof result.state !== "object" || result.state === null || !("names" in result.state)
      || !Array.isArray(result.state.names)) throw new TypeError("invalid transaction state");
    expect.soft(result.errors).toEqual(expectedErrors);
    expect(result.state.names.includes("service-owner.json")).toBe(ownerSurvives);
  });

  it("preserves an owner collision", async () => {
    const result = await runCase("none", true);
    if (typeof result.state !== "object" || result.state === null || !("owner" in result.state)) {
      throw new TypeError("invalid collision state");
    }
    expect.soft(result.errors).toEqual([expect.stringContaining("EEXIST")]);
    expect(result.state.owner).toBe("collision\n");
  });

  it("preserves exact owner evidence in quarantine when rollback removal fails", async () => {
    const result = await runCase("rollback");
    if (typeof result.state !== "object" || result.state === null || !("names" in result.state)
      || !("expected" in result.state) || !("removing" in result.state) || !("removingIdentity" in result.state)
      || !("sourceIdentity" in result.state) || !Array.isArray(result.state.names)) {
      throw new TypeError("invalid rollback quarantine state");
    }
    expect.soft(result.errors).toEqual(["PRIMARY_SYNC", "ROLLBACK"]);
    expect.soft(result.state.names.filter((name) => typeof name === "string" && name.includes("service-owner.json.removing-"))).toHaveLength(1);
    expect.soft(result.state.removingIdentity).toEqual(result.state.sourceIdentity);
    expect(result.state.removing).toBe(result.state.expected);
  });

  it("preserves an owner replacement introduced before rollback removal", async () => {
    const result = await runCase("owner-replaced");
    if (typeof result.state !== "object" || result.state === null || !("owner" in result.state)) {
      throw new TypeError("invalid replacement state");
    }
    expect.soft(result.errors).toEqual(["PRIMARY_SYNC", "refusing to roll back replaced service owner"]);
    expect(result.state.owner).toBe("replacement\n");
  });
});
