import { readFile, realpath } from "node:fs/promises";
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
  let entrypoint = -1;
  for (let index = 1; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (!token.startsWith("/") || !inside(token, paths.data)) continue;
    // npm bin links need not have a .js suffix. Verify their actual owned target.
    let target: string;
    try { target = await realpath(token); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; target = token; }
    if (inside(target, paths.data) && /\.(?:js|mjs|ts)$/.test(target)) { entrypoint = index; break; }
  }
  if (start.length !== 1 || !unit.includes("Description=DIM managed controller\n") || entrypoint < 0
    || !inside(tokens[entrypoint]!, paths.data) || tokens[entrypoint + 1] !== "controller" || tokens[entrypoint + 2] !== "serve") {
    throw new Error("DIM controller unit does not belong to the selected installation");
  }
  return true;
}
export async function stopControllerUnit(run: Command, owned: boolean): Promise<void> {
  if (owned) await checked(run, "systemctl", ["--user", "disable", "--now", "dim-controller.service"]);
}
