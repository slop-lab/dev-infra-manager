import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright-core";

const executablePath = process.env.DIM_CHROMIUM;
if (!executablePath) throw new Error("DIM_CHROMIUM is required");
const source = await readFile(new URL("../../../../packages/web/plugins/llm-router/src/assets/traffic.js", import.meta.url), "utf8");
const uiSource = await readFile(new URL("../../../../packages/web/core/src/assets/feature-ui.js", import.meta.url), "utf8");
const requestId = "10000000-0000-4000-8000-000000000001";
const browser = await chromium.launch({ executablePath, headless: true });
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(10_000);
  await page.route("http://localhost/", (route) => route.fulfill({ contentType: "text/html", body: "<main></main>" }));
  await page.goto("http://localhost/");
  await page.evaluate(`(async () => {
    const {mountTraffic} = await import(${JSON.stringify(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`)});
    const {featureUi} = await import(${JSON.stringify(`data:text/javascript;base64,${Buffer.from(uiSource).toString("base64")}`)});
    const requests = [{id:${JSON.stringify(requestId)},project_id:"example",model:"model-one",outcome:"uncertain",execution:"outcome_unknown",accounting:"reconciliation_required",started_at:1700000000000,finished_at:1700000001000}];
    globalThis.traffic = mountTraffic(document.querySelector("main"), {
      ui:featureUi, operations:[{name:"request.resolve"}],
      navigation:{openFeature:async()=>({status:"opened",message:"Opened"})},
      async invoke(name) {
        if(name==="principals") return [];
        if(name==="request.resolve") throw Object.assign(new Error("Response unavailable"),{outcome:"unknown"});
        if(name!=="requests") throw new Error("Unexpected operation");
        const snapshot=structuredClone(requests);
        if(globalThis.holdRead) {globalThis.holdRead=false;await new Promise(resolve=>{globalThis.releaseRead=resolve;});}
        return snapshot;
      }
    },{current:()=>true});
    await globalThis.traffic.refresh();
  })()`);
  const row = page.locator("article").filter({ hasText: `Request ${requestId}` });
  await row.getByLabel("Observed input tokens", { exact: true }).fill("8");
  await row.getByLabel("Observed output tokens", { exact: true }).fill("3");
  await page.evaluate("globalThis.holdRead=true;globalThis.staleRead=globalThis.traffic.refresh(true);void 0");
  await page.waitForFunction("typeof globalThis.releaseRead==='function'");
  page.once("dialog", (dialog) => dialog.accept());
  await row.getByRole("button", { name: /Resolve unknown outcome/ }).click();
  await row.getByText(/The resolution outcome is unknown/).waitFor();
  await page.evaluate("globalThis.releaseRead();globalThis.staleRead");
  assert.equal(await row.getByRole("button", { name: /Resolve unknown outcome/ }).count(), 0);
  await row.getByText("The resolution outcome is unknown. Use Refresh router to check authoritative request state before retrying.", { exact: true }).waitFor();
  await page.evaluate("globalThis.traffic.refresh(true)");
  await row.getByLabel("Observed input tokens", { exact: true }).waitFor();
  assert.equal(await row.getByLabel("Observed input tokens", { exact: true }).inputValue(), "8");
  assert.equal(await row.getByLabel("Observed output tokens", { exact: true }).inputValue(), "3");
  console.log("Pre-mutation router read cannot reconcile a newer unknown outcome PASS");
} finally { await browser.close(); }
