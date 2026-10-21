import { join, resolve } from "node:path";
import { checked, type Command } from "./command.ts";
import { object, text } from "./files.ts";
import { inside } from "./paths.ts";
export const installerTool = "npm:@slop-lab/dim-installer";
export async function planMise(run: Command, env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  let result;
  try { result = await run("mise", ["ls", "--json", installerTool]); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  if (result.status !== 0) throw new Error("could not inspect mise DIM installer registrations");
  const rows: unknown = JSON.parse(result.stdout);
  if (!Array.isArray(rows)) throw new Error("invalid mise installer list");
  const base = resolve(env.MISE_DATA_DIR ?? join(env.XDG_DATA_HOME ?? join(text(env.HOME), ".local/share"), "mise"), "installs");
  return rows.map((raw) => {
    const row = object(raw), version = text(row.version), path = resolve(text(row.install_path));
    if (!/^[a-zA-Z0-9][a-zA-Z0-9.+-]*$/.test(version) || !inside(path, base)) throw new Error("unexpected mise installer registration");
    return `${installerTool}@${version}`;
  });
}
export async function removeMise(run: Command, versions: readonly string[]): Promise<void> {
  if (!versions.length) return;
  await checked(run, "mise", ["unuse", "--global", "--no-prune", installerTool]);
  for (const version of versions) await checked(run, "mise", ["uninstall", version]);
}
