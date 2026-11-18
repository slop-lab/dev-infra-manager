import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { chromium, type Page } from "playwright-core";
import { z } from "zod";

const httpsOrigin = z.string().refine((value) => {
  const url = URL.parse(value);
  return url?.protocol === "https:" && url.origin === value;
});
const profileSchema = z.object({
  web: z.url(), username: z.string().min(1), password: z.string().min(1),
  workspaces: z.array(z.object({
    host: z.string().min(1), name: z.string().min(1), t3Origin: httpsOrigin, project: z.string().min(1),
    omp: z.boolean().optional(),
  }).strict()).min(1),
}).strict();

async function authenticated(page: Page) {
  const result = await page.evaluate(async () => {
    const response = await fetch("/api/auth/session", { cache: "no-store" });
    return { status: response.status, body: await response.json() };
  });
  assert.equal(result.status, 200);
  return z.object({ authenticated: z.boolean() }).parse(result.body).authenticated;
}

const profilePath = process.env.DIM_T3_EXAMPLE_PROFILE;
const executablePath = process.env.DIM_CHROMIUM;
if (!profilePath || !isAbsolute(profilePath) || !executablePath || !isAbsolute(executablePath)) {
  throw new Error("Set absolute DIM_T3_EXAMPLE_PROFILE and DIM_CHROMIUM paths");
}
const permissions = await stat(profilePath);
assert(permissions.isFile() && (permissions.mode & 0o077) === 0, "The browser verification profile must be private");
const profile = profileSchema.safeParse(JSON.parse(await readFile(profilePath, "utf8")) as unknown);
if (!profile.success) throw new Error("Invalid T3 browser verification profile");
const { web, username, password, workspaces } = profile.data;
assert.equal(new Set(workspaces.map(({ t3Origin }) => t3Origin)).size, workspaces.length);

const browser = await chromium.launch({ executablePath, headless: true });
const session = await browser.newContext();
const anonymous = await browser.newContext();
const page = await session.newPage();
page.setDefaultTimeout(25_000);
let step = "DIM Web login";
try {
  const pairingApi = new URL("/v1/extensions/agent-tools/operations/t3.pair", web);
  assert.equal((await anonymous.request.post(pairingApi.href, { data: {} })).status(), 401);
  await page.goto(web);
  await page.getByLabel("Username", { exact: true }).fill(username);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();

  for (const { host, name, t3Origin, project, omp } of workspaces) {
    step = "select workspace and inspect T3 service";
    await page.getByRole("link", { name: `Open ${name} on ${host}`, exact: true }).click();
    const row = page.locator(".workspace-host").filter({ has: page.getByRole("heading", { name: host, exact: true }) })
      .locator(".workspace-row").filter({ has: page.getByRole("heading", { name, exact: true }) });
    await row.getByRole("link", { name: "Tools", exact: true }).click();
    await row.getByText("Service running on workspace port 3773.", { exact: true }).waitFor();
    step = "check unauthenticated T3 HTTPS access";
    const unpaired = await anonymous.newPage();
    await unpaired.goto(`${t3Origin}/api/auth/session`);
    assert.equal(await authenticated(unpaired), false);

    step = "click Open T3 Code in DIM Web";
    const pairing = page.waitForResponse((response) => response.url() === pairingApi.href && response.request().method() === "POST");
    const popup = page.waitForEvent("popup");
    await row.getByRole("button", { name: "Open T3 Code", exact: true }).click();
    const client = await popup;
    client.setDefaultTimeout(30_000);
    step = "check the authenticated DIM pairing response";
    const response = await pairing;
    assert.equal(response.status(), 200);
    assert.equal(await response.headerValue("cache-control"), "no-store");
    const grant = z.object({ credential: z.string(), origin: httpsOrigin }).parse(await response.json());
    assert.equal(new URL(grant.origin).origin, t3Origin);
    step = "wait for T3 to exchange the one-time grant";
    await client.waitForURL((url) => url.origin === t3Origin && url.pathname !== "/pair" && !url.hash.includes("token="), { timeout: 60_000, waitUntil: "domcontentloaded" });
    step = "open the workspace project in T3";
    const projectButton = client.getByRole("button", { name: `New thread in ${project}`, exact: true }).first();
    await projectButton.waitFor();
    step = "verify T3 session and secure cookie";
    assert.equal(await authenticated(client), true);
    const cookie = (await session.cookies(t3Origin)).find(({ name }) => name.startsWith("t3_session"));
    assert(cookie?.secure && cookie.httpOnly);
    assert.equal(await client.evaluate(() => window.opener === null), true);
    step = "reject reuse of the spent T3 grant";
    const replayed = await unpaired.evaluate(async (credential) => (await fetch("/api/auth/browser-session", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ credential }),
    })).ok, grant.credential);
    assert.equal(replayed, false);
    assert.equal(await authenticated(unpaired), false);
    await unpaired.close();
    if (omp) {
      step = "send an OMP ACP message through the configured router";
      await projectButton.click();
      await client.getByRole("textbox", { name: /Message/ }).first().click();
      await client.keyboard.insertText("Reply exactly DIM_T3_BROWSER_OK. No tools.");
      await client.getByRole("button", { name: "Submit message", exact: true }).click();
      await client.getByText("DIM_T3_BROWSER_OK", { exact: true }).first().waitFor({ timeout: 90_000 });
    }
    await client.close();

    step = "reopen T3 with the existing browser session";
    let repeatedPairing = false;
    const observe = (request: { url(): string }) => { if (request.url() === pairingApi.href) repeatedPairing = true; };
    page.on("request", observe);
    const reopening = page.waitForEvent("popup");
    await row.getByRole("link", { name: "Open T3 Code", exact: true }).click();
    const reopened = await reopening;
    await reopened.waitForURL((url) => url.origin === t3Origin);
    await reopened.getByRole("button", { name: `New thread in ${project}`, exact: true }).first().waitFor();
    assert.equal(await authenticated(reopened), true);
    assert.equal(repeatedPairing, false);
    page.off("request", observe);
    await reopened.close();
    console.log(`T3 browser verification passed for ${host}/${name}`);
  }
} catch (error) {
  // Browser diagnostics may include the pairing fragment or a form value.
  const diagnostic = error instanceof Error ? (/net::ERR_[A-Z_]+|Execution context was destroyed|Target page, context or browser has been closed/.exec(error.message)?.[0] ?? error.name) : "error";
  console.error(`T3 browser verification failed at ${step} (${diagnostic})`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
