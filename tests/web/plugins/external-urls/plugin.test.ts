import { expect, it } from "vitest";
import { operations, webPlugin } from "../../../../packages/web/plugins/external-urls/src/index.js";
const workspaceId = "17094660-a627-4a17-acd2-6418c0b79967", selection = { controllerId: "local", workspace: "development", workspaceId };
const result = { workspace: "development", workspaceId, ingresses: [{ name: "public", description: "Configured DNS", scheme: "https", driver: "caddy" }], routes: [{ id: "37094660-a627-4a17-acd2-6418c0b79967", ingress: "public", url: "https://opencode.example.test", approval: "pending", port: 4096, containers: [], protocol: "http" }] };
it("contributes workspace controls and delegates only exact scoped operations to configured controllers", async () => {
  const calls: Array<{args:readonly string[];timeout:number|undefined}> = [];
  const runtime = await webPlugin.autoConnect!({ controllers: [{ id: "local", async run(args,options) {calls.push({args,timeout:options?.timeoutMilliseconds});return result;} }] });
  expect(webPlugin.surfaces).toEqual(["workspace"]);
  expect(await runtime.invoke("routes.create",{...selection,ingress:"public",name:"opencode",port:4096,protocol:"http"})).toEqual(result);
  expect(calls).toEqual([{args:["external-url","console","invoke","routes.create","--input",JSON.stringify({workspace:"development",workspaceId,ingress:"public",name:"opencode",port:4096,protocol:"http"})],timeout:120_000}]);
  await expect(runtime.invoke("routes.list",{...selection,controllerId:"foreign"})).rejects.toThrow();
  await expect(runtime.invoke("routes.create",{...selection,ingress:"public",name:"opencode",port:4096,command:"sh"})).rejects.toThrow();
  await expect(runtime.invoke("routes.approve",{...selection,id:"../outside"})).rejects.toThrow();
  await expect(runtime.invoke("unknown",selection)).rejects.toThrow();
  expect(calls).toHaveLength(1);
});
it("keeps identity, response shape and route URLs within the host-owned contract",async()=>{
  const runtime = await webPlugin.autoConnect!({controllers:[{id:"local",async run(){return {...result,workspaceId:"27094660-a627-4a17-acd2-6418c0b79967"};}}]});
  await expect(runtime.invoke("routes.list",selection)).rejects.toThrow("identity");
  const operation = operations.find(({name})=>name==="routes.list")!;
  for (const url of ["javascript:alert(1)","https://secret:password@example.test/","file:///etc/passwd"]) expect(()=>operation.parseOutput({...result,routes:[{...result.routes[0],url}]})).toThrow();
  expect(()=>operation.parseOutput({...result,credentials:"private"})).toThrow();
  expect(operations.filter(({access})=>access==="operator").map(({name})=>name)).toEqual(["routes.create","routes.approve","routes.revoke"]);
});
