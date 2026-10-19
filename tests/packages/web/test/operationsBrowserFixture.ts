import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { createReviewerWebServerFromConfigFile } from "../../../../core/packages/web/src/server.js";
import { initializeOperationsWeb } from "../../../../core/packages/web/src/initialize.js";
import { configuredExecutionServer } from "../../../../core/packages/managed/src/ci/service.js";
import { executionServiceConfigSchema } from "../../../../core/packages/managed/src/ci/config.js";
import { idleOrdinaryConfig } from "../../native-git/test/bundleConfigFixture.js";
import { event, generation, grant, slot, result, hash } from "../../core/test/ci/executionFixture.js";
export async function createOperationsBrowserFixture() {
  const root = await mkdtemp(join(tmpdir(), "dim-operations-browser-"));
  const config = executionServiceConfigSchema.parse(idleOrdinaryConfig());
  const ci = configuredExecutionServer({ config, stateDirectory: join(root, "ci-state"), readinessToken: "ready", activationToken: "activate", expectedGenerationId: generation,
    source: { authorize: async (job) => grant(job), candidate: async () => { throw new Error("unused"); }, publish: async () => {} } });
  try {
    await new Promise<void>((resolve) => ci.server.listen(0, "127.0.0.1", resolve));
    const address = ci.server.address(); if (!address || typeof address === "string") throw new Error("missing CI listener");
    const endpoint = `http://127.0.0.1:${address.port}`;
    const activation = await fetch(endpoint + "/v1/activation", { method: "POST", headers: { authorization: "Bearer activate", "content-type": "application/json" }, body: JSON.stringify({ schemaVersion: 1, generationId: generation }) });
    if (activation.status !== 200) throw new Error("activation failed");
    ci.store.enqueue(event("completed"));
    const assignment = ci.store.reserve("host-a", slot, randomUUID())!;
    const authorized = ci.store.attachGrant(assignment.id, grant(assignment)), evidence = result(authorized.grant!);
    const output = Buffer.from("browser-safe-diagnostic\n");
    evidence.stdout = { bytes: String(output.length), sha256: `sha256:${hash(output.toString())}`, truncated: false };
    evidence.logs.stdout.base64 = output.toString("base64");
    ci.store.finish(authorized.id, "host-a", slot.id, authorized.leaseToken, evidence);
    const queued = ci.store.enqueue(event("queued"));
    for (const role of ["query", "operator"] as const) await writeFile(join(root, `ci-${role}.json`), JSON.stringify({ schemaVersion: 1, role, endpoint, generationId: generation, credential: config.credentials[role] }), { mode: 0o600 });
    const workspace = { id: randomUUID(), name: "development", runtime: "container", phase: "running", runtimeStatus: "running", resources: { cpuCount: "1", memory: "2g", pidsLimit: "512" } };
    const state = join(root, "workspace.json"), executable = join(root, "dim"); await writeFile(state, JSON.stringify([workspace]));
    await writeFile(executable, `#!${process.execPath}
import fs from 'node:fs';import { randomUUID } from 'node:crypto';
const path=${JSON.stringify(state)}, rows=JSON.parse(fs.readFileSync(path,'utf8')), args=process.argv.slice(2);
const flag=(name,fallback)=>{const index=args.indexOf(name);return index<0?fallback:args[index+1]};
if(args[0]!=='--host'||args[1]!=='configured-host')process.exit(1);
let selected=rows.find(row=>row.name===args[3]);
if(args.includes('--expect-id')&&flag('--expect-id')!==selected?.id)process.exit(1);
if(args[2]==='stop'){selected.phase='stopped';selected.runtimeStatus='stopped';}
if(args[2]==='create'){
 selected={id:randomUUID(),name:args[4],source:args[3],runtime:flag('--runtime','container'),image:flag('--image'),phase:'running',runtimeStatus:'running',resources:{cpuCount:flag('--cpus','2'),memory:flag('--memory','4g'),pidsLimit:flag('--pids','2048')}};
 rows.push(selected);
}
fs.writeFileSync(path,JSON.stringify(rows));console.log(JSON.stringify(args[2]==='ls'?rows:selected??{}));
`, { mode: 0o700 });
    const settings = join(root, "operations.json"), file = join(root, "web.json");
    await writeFile(settings, JSON.stringify({ hosts: [{ id: "devbox", selector: "configured-host", executable }], ci: { queryConnection: join(root, "ci-query.json"), operatorConnection: join(root, "ci-operator.json") } }), { mode: 0o600 });
    const portServer = createServer(); await new Promise<void>((resolve) => portServer.listen(0, "127.0.0.1", resolve));
    const portAddress = portServer.address(); if (!portAddress || typeof portAddress === "string") throw new Error("port missing");
    await new Promise<void>((resolve) => portServer.close(() => resolve()));
    const browser = await initializeOperationsWeb({ operations: settings, output: file, port: portAddress.port });
    const generated = JSON.parse(await readFile(file, "utf8")) as { accounts: Array<{ username: string; passwordHash: string; roles: string[] }> };
    const operatorAccount = generated.accounts[0]; if (!operatorAccount) throw new Error("generated operator missing");
    generated.accounts.push({ ...operatorAccount, username: "readonly", roles: ["read"] });
    await writeFile(file, JSON.stringify(generated), { mode: 0o600 });
    const web = await createReviewerWebServerFromConfigFile(file);
    return { origin: await web.listen(), username: browser.username, password: browser.password, queuedId: queued.id,
      workspace: async () => (JSON.parse(await readFile(state, "utf8")) as Array<{ id: string; name: string; phase: string }>).find((row) => row.name === "development")!,
      createdWorkspace: async () => (JSON.parse(await readFile(state, "utf8")) as Array<{ name: string; source: string; runtime: string; image: string; resources: { cpuCount: string } }>).find((row) => row.name === "browser-created"),
      execution: () => ci.store.get(queued.id), ci,
      async close() { await web.close(); await ci.close(); await rm(root, { recursive: true, force: true }); } };
  } catch (error) { await ci.close(); await rm(root, { recursive: true, force: true }); throw error; }
}
