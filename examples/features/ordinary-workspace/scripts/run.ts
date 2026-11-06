import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isAbsolute } from "node:path";

const config = process.env.DIM_SMOKE_CONFIG, hosts = process.env.DIM_SMOKE_HOSTS?.split(",");
if (!config || !isAbsolute(config) || !hosts?.length || hosts.some((name) => !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$/.test(name))) {
  throw new Error("Set DIM_SMOKE_CONFIG to an absolute reviewed profile and DIM_SMOKE_HOSTS to explicit comma-separated host names; no current host is selected implicitly");
}
const entry = fileURLToPath(new URL("../../../../scripts/checks/selected-host-usability-smoke.ts", import.meta.url));
const loader = fileURLToPath(new URL("../../../../tests/node_modules/tsx/dist/loader.mjs", import.meta.url));
const child = spawn(process.execPath, ["--import", loader, entry, "--config", config, ...hosts.flatMap((host) => ["--host", host]),
  ...(process.env.DIM_SMOKE_PREFLIGHT_ONLY === "1" ? ["--preflight-only"] : [])], { stdio: "inherit" });
child.once("error", (error) => { console.error(error.message); process.exitCode = 1; });
await new Promise<void>((resolve) => child.once("close", (code) => { process.exitCode = code ?? 1; resolve(); }));
