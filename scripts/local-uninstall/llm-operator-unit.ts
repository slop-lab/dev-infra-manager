import { readFile, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { metadata } from "./files.ts";
import { inside } from "./paths.ts";
import type { RemovalPaths } from "./types.ts";

export const llmOperatorUnitPath = (paths: RemovalPaths) => join(dirname(paths.unit), "dim-llm-router-operator.service");
/** Recognize the exact repository-owned API runtime and its selected service mode. */
export async function ownedLlmOperatorUnit(paths: RemovalPaths): Promise<boolean> {
  const file = llmOperatorUnitPath(paths), stat = await metadata(file);
  if (!stat) return false;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || stat.size > 65536) throw new Error("unsafe DIM LLM router operator unit");
  const unit = await readFile(file, "utf8");
  const starts = unit.split("\n").filter((line) => line.startsWith("ExecStart="));
  const tokens = (starts[0]?.slice("ExecStart=".length).replace(/^:/, "").match(/"(?:\\.|[^"\\])*"|[^ ]+/g) ?? []).map((token): string => {
    try { return (token.startsWith('"') ? JSON.parse(token) as string : token).replaceAll("%%", "%"); }
    catch { throw new Error("unsupported DIM LLM router operator unit argument quoting"); }
  });
  const executable = join(paths.data, "llm-operator/runtime/current/node_modules/.bin/dim-control-plane-llm-router");
  const target = await realpath(executable).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return executable; });
  const configuration = tokens[2] === "serve" ? join(paths.configuration, "llm/router.json") : join(paths.configuration, "llm/operator-service.json");
  if (starts.length !== 1 || !unit.includes("Description=DIM LLM router operator API\n") || tokens.length !== 4
    || !tokens[0]?.startsWith("/") || tokens[1] !== executable || !["serve", "operator-serve"].includes(tokens[2] ?? "")
    || tokens[3] !== configuration || !inside(target, join(paths.data, "llm-operator/runtime"))) {
    throw new Error("DIM LLM router operator unit does not belong to the selected installation");
  }
  const configStat = await metadata(configuration);
  // A broken installation may lack its config; still remove the exact owned unit.
  if (configStat && (!configStat.isFile() || configStat.isSymbolicLink() || configStat.uid !== process.getuid?.() || configStat.nlink !== 1 || (configStat.mode & 0o777) !== 0o600 || configStat.size > 1024 * 1024)) {
    throw new Error("unsafe DIM LLM router operator configuration");
  }
  return true;
}
