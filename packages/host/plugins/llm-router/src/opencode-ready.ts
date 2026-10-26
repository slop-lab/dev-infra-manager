import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export async function verifyOpenCodeServer(credentialsFile: string, port: number): Promise<void> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("invalid owned OpenCode port");
  const connection: unknown = JSON.parse(await readFile(process.env.DIM_LLM_ROUTER_CONNECTION_FILE ?? join(homedir(), ".config/dim/llm-router.json"), "utf8"));
  if (!connection || typeof connection !== "object" || !("endpoint" in connection) || typeof connection.endpoint !== "string" || !("token" in connection) || typeof connection.token !== "string") throw new Error("invalid scoped router connection");
  const [username, password] = (await readFile(credentialsFile, "utf8")).split("\n");
  if (!username || !password) throw new Error("owned OpenCode credentials are unavailable");
  const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  const get = async (path: string): Promise<unknown> => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { authorization }, redirect: "error", signal: AbortSignal.timeout(2000) });
    if (!response.ok) { await response.body?.cancel(); throw new Error("owned OpenCode routing inventory is not ready"); }
    return response.json();
  };
  const config = object(await get("/config")), providers = object(config.provider);
  const mode = process.env.DIM_LLM_ROUTER_OPENCODE_MODE ?? "router";
  if (mode !== "router" && mode !== "providers") throw new Error("invalid DIM OpenCode routing mode");
  const ids = mode === "providers" ? ["dim-responses", "dim-chat"] : ["openai"];
  const routed = ids.some((id) => {
    if (providers[id] === undefined) return false;
    const options = object(object(providers[id]).options);
    return options.baseURL === `${connection.endpoint}/v1` && options.apiKey === connection.token;
  });
  if (!routed) throw new Error("owned OpenCode server did not load the scoped router; rerun dim tools server after route recovery");
  if (typeof config.default_agent === "string") {
    const agents = await get("/agent");
    if (!Array.isArray(agents) || !agents.some((value: unknown) => object(value).name === config.default_agent)) throw new Error("configured OpenCode primary agent is absent from runtime inventory; inspect available agents without changing role models");
  }
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid owned OpenCode routing inventory");
  return Object.fromEntries(Object.entries(value));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  if (!file) throw new Error("owned OpenCode credentials path required");
  try { await verifyOpenCodeServer(file, Number(process.argv[3])); }
  catch (error) { process.stderr.write(`${error instanceof Error ? error.message : "OpenCode routing inventory unavailable"}\n`); process.exitCode = 1; }
}
