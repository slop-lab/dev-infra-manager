import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createWebServerFromConfigFile } from "../../../packages/web/core/src/server.js";
import { initializeOperationsWeb } from "../../../packages/web/core/src/initialize.js";
import { parseWebConfig } from "../../../packages/web/core/src/config.js";
import { availablePort } from "../webHarness.js";
import { initialWorkbenchState } from "./state.js";

export type NonGitWorkbench = {
  readonly origin: string;
  readonly username: string;
  readonly password: string;
  readonly readonlyUsername: string;
  readonly root: string;
  readonly capabilities: {
    readonly syntheticHosts: readonly string[];
    readonly syntheticDomains: readonly string[];
    readonly realProtocols: readonly string[];
  };
  close(): Promise<void>;
};

export async function createNonGitWorkbench(): Promise<NonGitWorkbench> {
  const root = await mkdtemp(join(tmpdir(), "dim-non-git-workbench-"));
  try {
    const statePath = join(root, "state.json");
    const controllerPath = join(root, "dim-fixture");
    const operationsPath = join(root, "operations.json");
    const configPath = join(root, "web.json");
    const controllerEntry = fileURLToPath(new URL("./controller.ts", import.meta.url));
    const tsxLoader = fileURLToPath(new URL("../../node_modules/tsx/dist/loader.mjs", import.meta.url));
    await writeFile(statePath, `${JSON.stringify(initialWorkbenchState())}\n`, { mode: 0o600 });
    await writeFile(controllerPath, `#!${process.execPath}\nimport{spawnSync}from"node:child_process";const result=spawnSync(process.execPath,["--disable-warning=DEP0205","--conditions=dim-source","--import",${JSON.stringify(tsxLoader)},${JSON.stringify(controllerEntry)},...process.argv.slice(2)],{stdio:"inherit",env:{...process.env,DIM_NON_GIT_WORKBENCH_STATE:${JSON.stringify(statePath)}}});if(result.error)throw result.error;process.exit(result.status??1);\n`, { mode: 0o700 });
    await writeFile(operationsPath, JSON.stringify({ hosts: [
      { id: "local", selector: "local", executable: controllerPath },
      { id: "remote", selector: "remote", executable: controllerPath },
      { id: "offline", selector: "offline", executable: controllerPath }
    ] }), { mode: 0o600 });
    const initialized = await initializeOperationsWeb({ operations: operationsPath, output: configPath, port: await availablePort() });
    const generated = parseWebConfig(JSON.parse(await readFile(configPath, "utf8")));
    const operator = generated.accounts[0];
    if (operator === undefined) throw new Error("generated operator account missing");
    await writeFile(configPath, `${JSON.stringify({
      ...generated,
      pluginHome: dirname(fileURLToPath(new URL("../../package.json", import.meta.url))),
      accounts: [operator, { ...operator, username: "evaluator", roles: ["read"] }],
      plugins: [
        { package: "@slop-lab/dim-web-plugin-agent-tools" },
        { package: "@slop-lab/dim-web-plugin-external-urls" },
        { package: "@slop-lab/dim-web-plugin-execution" },
        { package: "@slop-lab/dim-web-plugin-llm-router" }
      ]
    })}\n`, { mode: 0o600 });
    const web = await createWebServerFromConfigFile(configPath);
    const origin = await web.listen();
    return {
      origin,
      username: initialized.username,
      password: initialized.password,
      readonlyUsername: "evaluator",
      root,
      capabilities: {
        syntheticHosts: ["local", "remote", "offline"],
        syntheticDomains: ["workspace state", "OpenCode tools/server", "external routes", "LLM provider/accounts/routes/projects", "execution jobs/capacity"],
        realProtocols: ["DIM Web HTTP session and CSRF", "Web plugin discovery and authorization", "host controller execution contract"]
      },
      async close() { await web.close(); await rm(root, { recursive: true, force: true }); }
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
