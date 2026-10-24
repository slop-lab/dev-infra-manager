/** The complete repository development profile; published installation remains opt-in. */
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checked, command, type Command } from "./local-uninstall/command.ts";
import { object, text } from "./local-uninstall/files.ts";

export async function installLocalProfile(bundle: string, facade: string, run: Command = command, mode: "complete" | "host" = "complete"): Promise<void> {
  const manifest = object(JSON.parse(await readFile(join(bundle, "packages.json"), "utf8")));
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.packages)) throw new Error("invalid local package profile");
  const packages = manifest.packages.map(object);
  for (const target of mode === "host" ? ["host"] as const : ["host", "control-plane"] as const) {
    const plugins = packages.filter((entry) => text(entry.name).startsWith(`@slop-lab/dim-${target}-plugin-`))
      .map((entry) => `${text(entry.name)}@${text(entry.version)}`).sort();
    if (!plugins.length) throw new Error(`prepared bundle has no ${target} plugins`);
    console.log(`[install] ${target} development plugins`);
    await checked(run, facade, ["installer", "install", ...(target === "control-plane" ? ["control-plane"] : []), "plugin", "--local-packages", bundle, ...plugins]);
  }
}
if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const [bundle, facade, mode = "complete"] = process.argv.slice(2);
  if (!bundle || !facade || process.argv.length > 5 || !["complete", "host"].includes(mode)) throw new Error("Usage: node scripts/install-local-profile.ts BUNDLE FACADE [complete|host]");
  await installLocalProfile(bundle, facade, command, mode as "complete" | "host");
}
