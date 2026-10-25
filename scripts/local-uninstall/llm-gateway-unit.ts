import { readFile, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { metadata } from "./files.ts";
import { inside } from "./paths.ts";
import type { RemovalPaths } from "./types.ts";

export const llmGatewayUnitPath = (paths: RemovalPaths) => join(dirname(paths.unit), "dim-llm-router-gateway.service");
/** Recognize only the exact repository-owned workspace gateway. */
export async function ownedLlmGatewayUnit(paths: RemovalPaths): Promise<boolean> {
  const file = llmGatewayUnitPath(paths), stat = await metadata(file);
  if (!stat) return false;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || stat.size > 65536) throw new Error("unsafe DIM LLM router gateway unit");
  const unit = await readFile(file, "utf8");
  const starts = unit.split("\n").filter((line) => line.startsWith("ExecStart="));
  const tokens = (starts[0]?.slice("ExecStart=".length).replace(/^:/, "").match(/"(?:\\.|[^"\\])*"|[^ ]+/g) ?? []).map((token): string => {
    try { return (token.startsWith('"') ? JSON.parse(token) as string : token).replaceAll("%%", "%"); }
    catch { throw new Error("unsupported DIM LLM router gateway unit argument quoting"); }
  });
  const executable = join(paths.hostPlugins, "node_modules/.bin/dim-host");
  const target = await realpath(executable).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return executable; });
  const runtime = await realpath(paths.hostPlugins).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return paths.hostPlugins; });
  const configuration = join(paths.configuration, "llm-host/gateway.json");
  if (starts.length !== 1 || !unit.includes("Description=DIM LLM router host gateway\n") || tokens.length !== 5
    || !tokens[0]?.startsWith("/") || tokens[1] !== executable || tokens[2] !== "llm" || tokens[3] !== "serve"
    || tokens[4] !== configuration || !inside(target, runtime)) {
    throw new Error("DIM LLM router gateway unit does not belong to the selected installation");
  }
  const configStat = await metadata(configuration);
  // A broken installation may lack its config; still remove the exact owned unit.
  if (configStat && (!configStat.isFile() || configStat.isSymbolicLink() || configStat.uid !== process.getuid?.() || configStat.nlink !== 1 || (configStat.mode & 0o777) !== 0o600 || configStat.size > 1024 * 1024)) {
    throw new Error("unsafe DIM LLM router gateway configuration");
  }
  return true;
}
