import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultWebPluginPackages } from "./local-web-profile.ts";
import { installLocalRuntime, localArtifacts, type InstallCommand } from "./local-source-runtime.ts";
export type { InstallCommand } from "./local-source-runtime.ts";
export const webArtifacts = (manifest: unknown) => localArtifacts(manifest, ["@slop-lab/dim-web", ...defaultWebPluginPackages]);
/** Web and its presentation plugins never enter the host runtime. */
export async function installLocalWeb(bundle: string, dataHome: string, install?: InstallCommand): Promise<string> {
  return installLocalRuntime(bundle, dataHome, { component: "web", executable: "dim-web", packages: ["@slop-lab/dim-web", ...defaultWebPluginPackages], ...(install ? { install } : {}) });
}
if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const bundle = process.argv[2];
  if (!bundle || process.argv.length !== 3) throw new Error("Usage: node scripts/install-local-web.ts ABSOLUTE_PACKAGE_ROOT");
  const dataHome = process.env.DIM_DATA_HOME ?? join(process.env.XDG_DATA_HOME ?? join(process.env.HOME ?? "", ".local/share"), "dim");
  console.log(`[host] Web UI executable: ${await installLocalWeb(bundle, dataHome)}`);
}
