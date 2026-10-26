import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { createWebServerFromConfigFile } from "../../../../packages/web/core/src/server.js";
import { initializeOperationsWeb } from "../../../../packages/web/core/src/initialize.js";
import { parseWebConfig } from "../../../../packages/web/core/src/config.js";
import type { Page } from "playwright-core";

type WorkspaceInput = {
  readonly endpoint: string;
  readonly id: string;
  readonly selector: string;
  readonly directory: string;
};

export type DimWebFixture = {
  readonly origin: string;
  readonly username: string;
  readonly password: string;
  invocations(): Promise<readonly string[]>;
  setDirectory(selector: string, directory: string): Promise<void>;
  setEndpoint(selector: string, endpoint: string | null): Promise<void>;
  close(): Promise<void>;
};

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture port missing");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

export async function createDimWebFixture(workspaces: readonly WorkspaceInput[]): Promise<DimWebFixture> {
  let current: Array<Omit<WorkspaceInput, "endpoint"> & { readonly endpoint: string | null }> = workspaces.map((entry) => ({ ...entry }));
  const root = await mkdtemp(join(tmpdir(), "dim-opencode-link-web-"));
  const calls = join(root, "calls.json");
  const state = join(root, "state.json");
  const executable = join(root, "dim-fixture.mjs");
  const operations = join(root, "operations.json");
  const configPath = join(root, "web.json");
  await writeFile(calls, "", { mode: 0o600 });
  await writeFile(state, JSON.stringify(workspaces), { mode: 0o600 });
  await writeFile(executable, `#!${process.execPath}
import fs from "node:fs";
const args=process.argv.slice(2), rows=JSON.parse(fs.readFileSync(${JSON.stringify(state)},"utf8")), selector=args[1], row=rows.find((item)=>item.selector===selector);
if(args[0]!=="--host"||!row)process.exit(2);
fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(args.slice(2))+"\\n");
if(args[2]==="ls"){console.log(JSON.stringify([{name:"development",id:row.id,phase:"running",runtime:"container",runtimeStatus:"running",resources:{cpuCount:"1",memory:"2g",pidsLimit:"512"}}]));process.exit(0)}
if(args[2]==="tools"&&args[4]==="describe"){console.log(JSON.stringify({schemaVersion:1,workspaces:[{name:"development",id:row.id,phase:"running"}],tools:["opencode"]}));process.exit(0)}
const inputIndex=args.indexOf("--input"), input=inputIndex<0?{}:JSON.parse(args[inputIndex+1]);
if(args[2]==="external-url"){console.log(JSON.stringify({workspace:"development",workspaceId:row.id,ingresses:[{name:"fixture",description:"fixture",scheme:"https",driver:"fixture"}],routes:row.endpoint?[{id:row.id,ingress:"fixture",url:row.endpoint,approval:"approved",port:4096,containers:[],protocol:"http"}]:[]}));process.exit(0)}
if(args[2]==="tools"&&args[4]==="invoke"){
 const name=args[5];
 if(name==="tools.status"){console.log(JSON.stringify({workspace:"development",workspaceId:row.id,tools:[{name:"opencode",installed:true,version:"1.18.31"}]}));process.exit(0)}
 if(name==="server.status"){console.log(JSON.stringify({workspace:"development",workspaceId:row.id,state:"running",port:4096,url:"http://127.0.0.1:4096",directory:row.directory,username:"opencode",credentialsFile:"/fixture/credentials",logFile:"/fixture/server.log"}));process.exit(0)}
}
console.error("unsupported fixture command",JSON.stringify(args));process.exit(2);
`, { mode: 0o700 });
  await writeFile(operations, JSON.stringify({ hosts: workspaces.map(({ selector }) => ({ id: selector, selector, executable })) }), { mode: 0o600 });
  try {
    const initialized = await initializeOperationsWeb({ operations, output: configPath, port: await availablePort() });
    const generated = parseWebConfig(JSON.parse(await readFile(configPath, "utf8")));
    const configured = {
      ...generated,
      pluginHome: fileURLToPath(new URL("../../../", import.meta.url)),
      plugins: [{ package: "@slop-lab/dim-web-plugin-agent-tools" }],
    };
    await writeFile(configPath, JSON.stringify(configured), { mode: 0o600 });
    const web = await createWebServerFromConfigFile(configPath);
    return {
      origin: await web.listen(),
      username: initialized.username,
      password: initialized.password,
      async invocations() {
        return (await readFile(calls, "utf8")).split("\n").filter(Boolean);
      },
      async setDirectory(selector, directory) {
        const row = current.find((entry) => entry.selector === selector);
        if (!row) throw new Error("workspace fixture missing");
        current = current.map((entry) => entry === row ? { ...entry, directory } : entry);
        await writeFile(state, JSON.stringify(current), { mode: 0o600 });
      },
      async setEndpoint(selector, endpoint) {
        const row = current.find((entry) => entry.selector === selector);
        if (!row) throw new Error("workspace fixture missing");
        current = current.map((entry) => entry === row ? { ...entry, endpoint } : entry);
        await writeFile(state, JSON.stringify(current), { mode: 0o600 });
      },
      async close() { await web.close(); await rm(root, { recursive: true, force: true }); },
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

export type StorageTarget = {
  readonly endpoint: string;
  readonly directory: string;
  readonly username: string;
  readonly password: string;
};

export async function clientSummary(page: Page, targets: readonly StorageTarget[]) {
  return page.evaluate((expected) => {
    const helpers = {
      record(value: unknown, label: string): Record<string, unknown> {
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid client store shape: ${label}`);
        return Object.fromEntries(Object.entries(value));
      },
      parsed(key: string, fallback: unknown): unknown {
        const raw = localStorage.getItem(key);
        if (raw === null) return fallback;
        try { return JSON.parse(raw); }
        catch (error) { if (error instanceof SyntaxError) throw new Error("Invalid client store JSON"); throw error; }
      },
    };
    const { record, parsed } = helpers;
    const server = record(parsed("opencode.global.dat:server", { list: [], projects: {} }), "server");
    if (!Array.isArray(server.list)) throw new Error("Invalid server registration list");
    const connections = server.list.map((entry: unknown) => {
      const connection = record(entry, "connection");
      return record(connection.http, "connection-http");
    });
    const projects = record(server.projects, "projects");
    const tabs = parsed("opencode.window.browser.dat:tabs", []);
    if (!Array.isArray(tabs)) throw new Error("Invalid client tabs");
    const drafts = tabs.map((entry: unknown) => record(entry, "tab")).filter((entry) => entry.type === "draft");
    const recent = record(parsed("opencode.window.browser.dat:tabs.recent", {}), "recent");
    return {
      serverCount: connections.length,
      uniqueEndpointCount: new Set(connections.map((entry) => entry.url)).size,
      draftCount: drafts.length,
      targets: expected.map((target) => {
        const matches = connections.filter((entry) => entry.url === target.endpoint);
        const storedProjects = projects[target.endpoint] ?? [];
        if (!Array.isArray(storedProjects)) throw new Error("Invalid client projects");
        const matchingDrafts = drafts.filter((entry) => entry.server === target.endpoint && entry.directory === target.directory);
        return {
          registrationCount: matches.length,
          projectCount: storedProjects.length,
          projectPresent: storedProjects.some((entry: unknown) => record(entry, "project").worktree === target.directory),
          draftCount: matchingDrafts.length,
          credentialsPreserved: matches.length === 1 && matches.every((entry) => entry.username === target.username && entry.password === target.password),
          defaultSelected: localStorage.getItem("opencode.settings.dat:defaultServerUrl") === target.endpoint,
          draftSelected: matchingDrafts.some((entry) => recent.key === `draft:${entry.draftID}`),
        };
      }),
    };
  }, targets);
}
