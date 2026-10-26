import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { createWebServerFromConfigFile } from "../../packages/web/core/src/server.js";
import { initializeOperationsWeb } from "../../packages/web/core/src/initialize.js";
export async function createOperationsBrowserFixture() {
  const root = await mkdtemp(join(tmpdir(), "dim-operations-browser-"));
  try {
    const workspace = { id: randomUUID(), name: "development", runtime: "container", phase: "running", runtimeStatus: "running", resources: { cpuCount: "1", memory: "2g", pidsLimit: "512" } };
    const state = join(root, "workspace.json"), executable = join(root, "dim"), failures = join(root, "failures.json"), actions = join(root, "actions.json"), delay = join(root, "delay.json");
    await writeFile(delay, "{}");
    const incomplete = { ...workspace, id: randomUUID(), name: "incomplete", initialized: false, phase: "error", runtimeStatus: "missing", error: "Docker run failed: pull access denied PRIVATE_SECRET /private/host/path" };
    await writeFile(state, JSON.stringify([workspace, incomplete])); await writeFile(failures, "{}"); await writeFile(actions, "[]");
    await writeFile(executable, `#!${process.execPath}
import fs from 'node:fs';import { randomUUID } from 'node:crypto';
const path=${JSON.stringify(state)}, failuresPath=${JSON.stringify(failures)}, actionsPath=${JSON.stringify(actions)}, rows=JSON.parse(fs.readFileSync(path,'utf8')), args=process.argv.slice(2);
const flag=(name,fallback)=>{const index=args.indexOf(name);return index<0?fallback:args[index+1]};
if(args[0]!=='--host'||args[1]!=='configured-host')process.exit(1);
const failures=JSON.parse(fs.readFileSync(failuresPath,'utf8'));
const delay=JSON.parse(fs.readFileSync(${JSON.stringify(delay)},'utf8'));
if(delay.action===args[2]){fs.writeFileSync(${JSON.stringify(delay)},'{}');await new Promise(resolve=>setTimeout(resolve,delay.milliseconds));}
if(failures[args[2]]){const diagnostic=failures[args[2]];delete failures[args[2]];fs.writeFileSync(failuresPath,JSON.stringify(failures));console.error(typeof diagnostic==='string'?diagnostic:'Temporary host connection failure');process.exit(1);}
const actions=JSON.parse(fs.readFileSync(actionsPath,'utf8'));actions.push(args[2]);fs.writeFileSync(actionsPath,JSON.stringify(actions));
let selected=rows.find(row=>row.name===args[3]);
if(args.includes('--expect-id')&&flag('--expect-id')!==selected?.id)process.exit(1);
if(args[2]==='stop'){selected.phase='stopped';selected.runtimeStatus='stopped';}
if(['start','restart','recreate'].includes(args[2])){selected.phase='running';selected.runtimeStatus='running';}
if(args[2]==='discard'){if(!args.includes('--yes')){console.error('discard requires --yes noninteractively');process.exit(2)}rows.splice(rows.indexOf(selected),1);}
if(args[2]==='resources'){for(const [key,option] of [['cpuCount','--cpus'],['memory','--memory'],['pidsLimit','--pids']])if(args.includes(option))selected.resources[key]=flag(option);}
if(args[2]==='create'){
 selected={id:randomUUID(),name:args[4],source:args[3],runtime:flag('--runtime','container'),image:flag('--image'),phase:'running',runtimeStatus:'running',resources:{cpuCount:flag('--cpus','2'),memory:flag('--memory','4g'),pidsLimit:flag('--pids','2048')}};
 rows.push(selected);
}
fs.writeFileSync(path,JSON.stringify(rows));console.log(JSON.stringify(args[2]==='ls'?rows:selected??{}));
`, { mode: 0o700 });
    const settings = join(root, "operations.json"), file = join(root, "web.json");
    await writeFile(settings, JSON.stringify({ hosts: [{ id: "devbox", selector: "configured-host", executable }] }), { mode: 0o600 });
    const portServer = createServer(); await new Promise<void>((resolve) => portServer.listen(0, "127.0.0.1", resolve));
    const portAddress = portServer.address(); if (!portAddress || typeof portAddress === "string") throw new Error("port missing");
    await new Promise<void>((resolve) => portServer.close(() => resolve()));
    const browser = await initializeOperationsWeb({ operations: settings, output: file, port: portAddress.port });
    const generated = JSON.parse(await readFile(file, "utf8")) as { accounts: Array<{ username: string; passwordHash: string; roles: string[] }> };
    const operatorAccount = generated.accounts[0]; if (!operatorAccount) throw new Error("generated operator missing");
    generated.accounts.push({ ...operatorAccount, username: "readonly", roles: ["read"] });
    await writeFile(file, JSON.stringify(generated), { mode: 0o600 });
    const web = await createWebServerFromConfigFile(file);
    return { origin: await web.listen(), username: browser.username, password: browser.password,
      failNextCreate: async () => writeFile(failures, JSON.stringify({ create: "Docker run failed: pull access denied PRIVATE_SECRET /private/host/path" })),
      failNextList: async () => writeFile(failures, JSON.stringify({ ls: true })),
      delayNextAction: async (action: "resources" | "recreate", milliseconds: number) => writeFile(delay, JSON.stringify({ action, milliseconds })),
      clearWorkspaces: async () => writeFile(state, "[]"),
      stopRuntime: async () => {
        const rows = JSON.parse(await readFile(state, "utf8")) as Array<{ name: string; runtimeStatus: string }>;
        rows.find((row) => row.name === "development")!.runtimeStatus = "stopped";
        await writeFile(state, JSON.stringify(rows));
      },
      actions: async () => JSON.parse(await readFile(actions, "utf8")) as string[],
      workspace: async () => (JSON.parse(await readFile(state, "utf8")) as Array<{ id: string; name: string; phase: string; resources: { cpuCount: string; memory: string; pidsLimit: string } }>).find((row) => row.name === "development")!,
      createdWorkspace: async () => (JSON.parse(await readFile(state, "utf8")) as Array<{ name: string; source: string; runtime: string; image: string; resources: { cpuCount: string } }>).find((row) => row.name === "browser-created"),
      workspaceNamed: async (name: string) => (JSON.parse(await readFile(state, "utf8")) as Array<{ id: string; name: string; phase: string; resources: { cpuCount: string; memory: string; pidsLimit: string } }>).find((row) => row.name === name),
      async close() { await web.close(); await rm(root, { recursive: true, force: true }); } };
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
}
