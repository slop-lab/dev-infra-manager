import { readFile, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { metadata } from "./files.ts";
import { inside } from "./paths.ts";
import type { RemovalPaths } from "./types.ts";

export const webUnitPath = (paths: RemovalPaths) => join(dirname(paths.unit), "dim-web.service");
export async function ownedWebUnit(paths: RemovalPaths): Promise<boolean> {
  const file = webUnitPath(paths), stat = await metadata(file);
  if (!stat) return false;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || stat.size > 65536) throw new Error("unsafe DIM Web UI unit");
  const unit = await readFile(file, "utf8");
  const starts = unit.split("\n").filter((line) => line.startsWith("ExecStart="));
  const tokens = (starts[0]?.slice("ExecStart=".length).replace(/^:/, "").match(/"(?:\\.|[^"\\])*"|[^ ]+/g) ?? []).map((token): string => {
    try { return (token.startsWith('"') ? JSON.parse(token) as string : token).replaceAll("%%", "%"); }
    catch { throw new Error("unsupported DIM Web UI unit argument quoting"); }
  });
  const executable = join(paths.data, "web/runtime/current/node_modules/.bin/dim-web");
  const target = await realpath(executable).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return executable; });
  if (starts.length !== 1 || !unit.includes("Description=DIM local Web UI\n") || tokens.length !== 4
    || !tokens[0]?.startsWith("/") || tokens[1] !== executable || tokens[2] !== "serve"
    || tokens[3] !== join(paths.configuration, "web/config.json") || !inside(target, join(paths.data, "web/runtime"))) {
    throw new Error("DIM Web UI unit does not belong to the selected installation");
  }
  return true;
}
