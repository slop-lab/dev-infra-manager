/** Restore the optional retained shared ingress during repository-only installation. */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { installLocalRuntime, localArtifacts, type InstallCommand } from "./local-source-runtime.ts";
import { checked, command, type Command } from "./local-uninstall/command.ts";
import { metadata, object } from "./local-uninstall/files.ts";
import { removalPaths } from "./local-uninstall/paths.ts";
import type { installPlugins as InstallerInstallPlugins } from "../packages/installer/src/pluginInstall.js";
import { selectedSharedIngressEdge } from "./local-uninstall/shared-ingress-edge.ts";
import { collectHostClaims } from "./local-uninstall/host-resources.ts";
import { sharedIngressUnitPath, ownedSharedIngressUnit } from "./local-uninstall/shared-ingress-unit.ts";

export const sharedIngressArtifacts = (manifest: unknown) => localArtifacts(manifest, ["@slop-lab/dim-control-plane-plugin-external-urls"]);
const hostPackage = "@slop-lab/dim-host-plugin-external-urls";
type InstallHost = (input: { home: string; version: string; files: string[] }) => Promise<void>;
const installHost: InstallHost = async ({ home, version, files }) => {
  const entry = new URL("../packages/installer/dist/pluginInstall.js", import.meta.url);
  const { installPlugins } = await import(entry.href) as { installPlugins: typeof InstallerInstallPlugins };
  await installPlugins([`${hostPackage}@${version}`], { pluginHome: home, pluginNames: [hostPackage], packageSpecifiers: files, restartController: true });
};
const quote = (value: string) => JSON.stringify(value.replaceAll("%", "%%"));
async function privateDirectory(directory: string): Promise<void> {
  const stat = await metadata(directory);
  if (!stat) { await privateDirectory(dirname(directory)); await mkdir(directory, { mode: 0o700 }); return; }
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0) throw new Error(`unsafe local shared ingress unit directory: ${directory}`);
}
export async function restoreLocalSharedIngress(bundle: string, env: NodeJS.ProcessEnv = process.env, run: Command = command, install?: InstallCommand, hostInstall: InstallHost = installHost): Promise<string | undefined> {
  const paths = removalPaths(env), configuration = join(paths.configuration, "shared-ingress/services.json");
  const configStat = await metadata(configuration);
  if (!configStat) return;
  if (!configStat.isFile() || configStat.isSymbolicLink() || configStat.nlink !== 1 || configStat.uid !== process.getuid?.() || (configStat.mode & 0o777) !== 0o600 || configStat.size > 1024 * 1024) throw new Error("retained shared ingress configuration must be an owned mode-0600 regular file");
  const config = object(JSON.parse(await readFile(configuration, "utf8")));
  if (config.schemaVersion !== 1 || !Array.isArray(config.plugins) || config.plugins.length !== 1 || object(config.plugins[0]).package !== "@slop-lab/dim-control-plane-plugin-external-urls") throw new Error("retained shared ingress must select only its reviewed external-urls plugin");
  const mode = "run";
  await ownedSharedIngressUnit(paths); // Refuse to replace a foreign listener's unit.
  const executable = await installLocalRuntime(bundle, paths.data, { component: "shared-ingress", executable: "dim-control-plane", packages: ["@slop-lab/dim-control-plane-plugin-external-urls"], ...(install ? { install } : {}) });
  const hostConfig = await metadata(join(paths.configuration, "external-urls.json"));
  if (hostConfig) {
    if (!hostConfig.isFile() || hostConfig.isSymbolicLink() || hostConfig.nlink !== 1 || hostConfig.uid !== process.getuid?.() || (hostConfig.mode & 0o077) !== 0) throw new Error("unsafe retained external URL configuration");
    const artifacts = localArtifacts(JSON.parse(await readFile(join(bundle, "packages.json"), "utf8")), [hostPackage]);
    await hostInstall({ home: paths.hostPlugins, version: artifacts.find(({ name }) => name === hostPackage)!.version, files: artifacts.map(({ file }) => join(bundle, file)) });
  }
  let systemd = false;
  try { systemd = (await run("systemctl", ["--user", "show-environment"])).status === 0; } catch { /* A manual listener remains possible without systemd. */ }
  if (!systemd) {
    console.log(`[host] no user systemd; start retained shared ingress with: ${process.execPath} ${executable} ${mode} ${configuration}`);
    return executable;
  }
  const unit = sharedIngressUnitPath(paths);
  await privateDirectory(dirname(unit));
  const environment = Object.entries({ HOME: env.HOME, PATH: [dirname(process.execPath), env.PATH].filter(Boolean).join(":") })
    .filter((entry): entry is [string, string] => entry[1] !== undefined).map(([name, value]) => `Environment=${quote(`${name}=${value}`)}`).join("\n");
  const contents = `[Unit]\nDescription=DIM shared external URL ingress\nAfter=network.target\n\n[Service]\nType=simple\nExecStart=:${[process.execPath, executable, mode, configuration].map(quote).join(" ")}\n${environment}\nRestart=on-failure\nRestartSec=3\nUMask=0077\n\n[Install]\nWantedBy=default.target\n`;
  const stage = `${unit}.tmp-${process.pid}`;
  await writeFile(stage, contents, { flag: "wx", mode: 0o600 }); await rename(stage, unit);
  await checked(run, "systemctl", ["--user", "daemon-reload"]);
  await checked(run, "systemctl", ["--user", "enable", "dim-shared-ingress.service"]);
  await checked(run, "systemctl", ["--user", "restart", "dim-shared-ingress.service"]);
  await checked(run, "systemctl", ["--user", "is-active", "--quiet", "dim-shared-ingress.service"]);
  const edge = await selectedSharedIngressEdge(paths);
  if (edge) {
    // Parse the retained deployment with the same exact ownership rules used by removal.
    const claims = await collectHostClaims(paths);
    if (![edge.container, ...edge.volumes].every((name) => claims.some((claim) => claim.name === name))) throw new Error("retained shared ingress edge lacks its exact ownership records");
    await checked(run, "docker", ["compose", "--project-directory", edge.directory, "--project-name", edge.name, "--file", join(edge.directory, "compose.yml"), "up", "-d"]);
  }
  console.log("[host] retained shared ingress restored");
  return executable;
}
if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const bundle = process.argv[2];
  if (!bundle || process.argv.length !== 3) throw new Error("Usage: node scripts/install-local-shared-ingress.ts ABSOLUTE_PACKAGE_ROOT");
  await restoreLocalSharedIngress(bundle);
}
