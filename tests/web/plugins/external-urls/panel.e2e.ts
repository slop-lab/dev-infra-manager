import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {createServer} from "node:http";
import {chromium} from "playwright-core";
const executablePath=process.env.DIM_CHROMIUM;if(!executablePath)throw new Error("DIM_CHROMIUM must select the reviewed Chromium executable");
const panel=await readFile(new URL("../../../../packages/web/plugins/external-urls/src/assets/panel.js",import.meta.url));
const featureUi=await readFile(new URL("../../../../packages/web/core/src/assets/feature-ui.js",import.meta.url));
const workspaceId="17094660-a627-4a17-acd2-6418c0b79967", calls:Array<{name:string;input:Record<string,unknown>}>=[];
let approval="pending", exists=false;
const snapshot=()=>({workspace:"development",workspaceId,ingresses:[{name:"public",description:"Existing DNS",scheme:"https",driver:"relay"}],routes:exists?[{id:"37094660-a627-4a17-acd2-6418c0b79967",ingress:"public",url:"https://opencode.example.test",permalink:"https://permanent.example.test/route/37094660-a627-4a17-acd2-6418c0b79967",port:4096,containers:[],protocol:"http",approval}]:[]});
const server=createServer((request,response)=>{
  if(request.url==="/"){response.setHeader("Content-Type","text/html");response.end('<!doctype html><main></main>');return;}
  if(request.url==="/panel.js"){response.setHeader("Content-Type","text/javascript");response.end(panel);return;}
  if(request.url==="/feature-ui.js"){response.setHeader("Content-Type","text/javascript");response.end(featureUi);return;}
  if(request.url!=="/invoke"){response.statusCode=404;response.end();return;}
  const chunks:Buffer[]=[];request.on("data",(chunk:Buffer)=>chunks.push(chunk));request.on("end",()=>{
    const call=JSON.parse(Buffer.concat(chunks).toString()) as {name:string;input:Record<string,unknown>};calls.push(call);
    if(call.name==="routes.create")exists=true;
    if(call.name==="routes.approve")approval="approved";
    if(call.name==="routes.revoke")approval="revoked";
    response.setHeader("Content-Type","application/json");response.end(JSON.stringify(snapshot()));
  });
});
await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));const address=server.address();if(!address||typeof address==="string")throw new Error("No fixture address");
const browser=await chromium.launch({executablePath,headless:true}),page=await browser.newPage(),errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));
async function mount(operator:boolean){await page.goto(`http://127.0.0.1:${typeof address==='object'&&address?address.port:0}`);await page.addScriptTag({type:"module",content:`import {mount} from '/panel.js';import {featureUi} from '/feature-ui.js';Object.defineProperty(navigator,'clipboard',{configurable:true,value:{async writeText(){throw new Error('clipboard unavailable');}}});mount(document.querySelector('main'),{ui:featureUi,workspace:${JSON.stringify({hostId:"local",name:"development",id:workspaceId,phase:"running"})},operations:${JSON.stringify(["routes.list",...(operator?["routes.create","routes.approve","routes.revoke"]:[])].map(name=>({name})))},isCurrent:()=>true,async invoke(name,input){const response=await fetch('/invoke',{method:'POST',body:JSON.stringify({name,input})});if(!response.ok)throw Object.assign(new Error('outcome unknown'),{outcome:'unknown'});return response.json();}});`});await page.getByText("Routes refreshed.",{exact:true}).waitFor();}
try{
  await mount(true);
  await page.getByLabel('Route name',{exact:true}).fill('Bad_Name!');
  assert.equal(await page.getByLabel('Route name',{exact:true}).evaluate((field) => field instanceof HTMLInputElement && field.checkValidity()),false);
  await page.getByRole('button',{name:'Create route',exact:true}).click();
  assert.equal(calls.some(({name})=>name==='routes.create'),false);
  await page.getByLabel('Route name',{exact:true}).fill('opencode');
  await page.getByRole("button",{name:"Create route",exact:true}).click();
  await page.getByText("Awaiting operator approval. This route is not available yet.",{exact:true}).waitFor();
  assert.equal(await page.getByRole("link").count(),0);assert.equal(calls.some(({name})=>name==="routes.approve"),false);
  assert.deepEqual(calls.find(({name})=>name==="routes.create")?.input,{controllerId:"local",workspace:"development",workspaceId,ingress:"public",name:"opencode",port:4096,protocol:"http"});
  await mount(false);
  await page.getByText("Awaiting operator approval. This route is not available yet.",{exact:true}).waitFor();
  assert.equal(await page.getByRole("link").count(),0);
  assert.equal(await page.getByRole("button",{name:"Approve route",exact:true}).count(),0);
  await mount(true);
  await page.getByRole("button",{name:"Approve route",exact:true}).click();await page.getByRole("link",{name:"https://opencode.example.test",exact:true}).waitFor();
  assert.equal(await page.getByRole("link",{name:"https://opencode.example.test",exact:true}).getAttribute("rel"),"noopener noreferrer");
  assert.equal(await page.getByRole("link",{name:"https://permanent.example.test/route/37094660-a627-4a17-acd2-6418c0b79967",exact:true}).count(),1);
  assert.equal(await page.getByText("Service URL:",{exact:false}).count(),1);assert.equal(await page.getByText("Permanent URL:",{exact:false}).count(),1);
  assert.deepEqual(await page.getByRole("link").allTextContents(),["https://opencode.example.test","https://permanent.example.test/route/37094660-a627-4a17-acd2-6418c0b79967"]);
  const beforeCopy = calls.length;
  await page.getByRole("button",{name:"Copy service URL",exact:true}).click();
  assert.equal(await page.getByLabel("Select and copy service URL",{exact:true}).inputValue(),"https://opencode.example.test");
  await page.getByRole("button",{name:"Copy permanent URL",exact:true}).click();
  assert.equal(await page.getByLabel("Select and copy permanent URL",{exact:true}).inputValue(),"https://permanent.example.test/route/37094660-a627-4a17-acd2-6418c0b79967");
  assert.equal(calls.length,beforeCopy);

   await page.getByRole("button",{name:"Revoke route",exact:true}).click();await page.getByRole("button",{name:"Keep route",exact:true}).click();await page.getByText('Route revocation dismissed.',{exact:true}).waitFor();assert.equal(approval,'approved');
   await page.getByRole("button",{name:"Revoke route",exact:true}).click();await page.getByRole("button",{name:"Revoke route now",exact:true}).click();await page.getByText("This route has been revoked.",{exact:true}).waitFor();assert.equal(await page.getByRole("link").count(),0);
  await mount(false);await page.getByText("This route has been revoked.",{exact:true}).waitFor();assert.equal(await page.getByRole("link").count(),0);
  approval="approved";await mount(false);await page.getByRole("link",{name:"https://opencode.example.test",exact:true}).waitFor();assert.equal(await page.getByRole("button",{name:"Create route",exact:true}).count(),0);assert.equal(await page.getByRole("button",{name:"Revoke route",exact:true}).count(),0);
  for(const {input} of calls)assert.deepEqual({workspace:input.workspace,workspaceId:input.workspaceId,controllerId:input.controllerId},{workspace:"development",workspaceId,controllerId:"local"});
  assert.deepEqual(errors,[]);process.stdout.write("Workspace route form, explicit approval, revocation and read-only rendering passed.\n");
}finally{await browser.close();await new Promise<void>(resolve=>server.close(()=>resolve()));}
