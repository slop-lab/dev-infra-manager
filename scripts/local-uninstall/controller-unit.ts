import { readFile } from "node:fs/promises";
import { checked, type Command } from "./command.ts";
import { metadata } from "./files.ts";
import { inside } from "./paths.ts";
import type { RemovalPaths } from "./types.ts";
export async function ownedControllerUnit(paths: RemovalPaths): Promise<boolean> {
  const stat = await metadata(paths.unit); if (!stat) return false;
  if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.isSymbolicLink() || stat.size > 65536) throw new Error("unsafe DIM controller unit");
  const unit = await readFile(paths.unit, "utf8");
  const start = unit.split("\n").filter((line) => line.startsWith("ExecStart="));
  const tokens = (start[0]?.slice("ExecStart=".length).match(/"(?:\\.|[^"\\])*"|[^ ]+/g) ?? []).map((token): string => {
    try { return (token.startsWith('"') ? JSON.parse(token) as string : token).replaceAll("%%", "%"); }
    catch { throw new Error("unsupported DIM controller unit argument quoting"); }
  });
  const entrypoint = tokens.findIndex((token) => token.startsWith("/") && /\.(?:js|mjs|ts)$/.test(token));
  if (start.length !== 1 || !unit.includes("Description=DIM managed controller\n") || entrypoint < 0
    || !inside(tokens[entrypoint]!, paths.data) || tokens[entrypoint + 1] !== "controller" || tokens[entrypoint + 2] !== "serve") {
    throw new Error("DIM controller unit does not belong to the selected installation");
  }
  return true;
}
export async function stopControllerUnit(run: Command, owned: boolean): Promise<void> {
  if (owned) await checked(run, "systemctl", ["--user", "disable", "--now", "dim-controller.service"]);
}
