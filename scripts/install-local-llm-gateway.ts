/** Restore the optional host gateway from retained private configuration. */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checked, command, type Command } from "./local-uninstall/command.ts";
import { metadata, object } from "./local-uninstall/files.ts";
import { removalPaths } from "./local-uninstall/paths.ts";
import { llmGatewayUnitPath, ownedLlmGatewayUnit } from "./local-uninstall/llm-gateway-unit.ts";
import { localArtifacts } from "./local-source-runtime.ts";
import type { installPlugins as InstallerInstallPlugins } from "../packages/installer/src/pluginInstall.js";
const packageName = "@slop-lab/dim-host-plugin-llm-router";
type InstallHost = (input: { home: string; version: string; files: string[] }) => Promise<void>;
const installHost: InstallHost = async ({ home, version, files }) => {
  const entry = new URL("../packages/installer/dist/pluginInstall.js", import.meta.url);
  const { installPlugins } = await import(entry.href) as { installPlugins: typeof InstallerInstallPlugins };
  await installPlugins([`${packageName}@${version}`], { pluginHome: home, pluginNames: [packageName], packageSpecifiers: files, restartController: false });
};
const quote = (value: string) => JSON.stringify(value.replaceAll("%", "%%"));
export async function restoreLocalLlmGateway(bundle: string, env: NodeJS.ProcessEnv = process.env, run: Command = command, install: InstallHost = installHost): Promise<void> {
  const paths = removalPaths(env), configuration = join(paths.configuration, "llm-host/gateway.json");
  const stat = await metadata(configuration); if (!stat) return;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600 || stat.size > 1024 * 1024) throw new Error("retained LLM gateway configuration must be an owned mode-0600 regular file");
  object(JSON.parse(await readFile(configuration, "utf8")));
  await ownedLlmGatewayUnit(paths);
  const artifacts = localArtifacts(JSON.parse(await readFile(join(bundle, "packages.json"), "utf8")), [packageName]);
  await install({ home: paths.hostPlugins, version: artifacts.find(({ name }) => name === packageName)!.version, files: artifacts.map(({ file }) => join(bundle, file)) });
  const executable = join(paths.hostPlugins, "node_modules/.bin/dim-host");
  const args = [process.execPath, executable, "llm", "serve", configuration];
  let systemd = false; try { systemd = (await run("systemctl", ["--user", "show-environment"])).status === 0; } catch { /* optional systemd */ }
  if (!systemd) { console.log(`[host] start retained LLM gateway with: ${args.map(quote).join(" ")}`); return; }
  const unit = llmGatewayUnitPath(paths), directory = dirname(unit), existing = await metadata(directory);
  if (existing && (!existing.isDirectory() || existing.isSymbolicLink() || existing.uid !== process.getuid?.() || (existing.mode & 0o022) !== 0)) throw new Error("unsafe LLM gateway unit directory");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const environment = Object.entries({ HOME: env.HOME, PATH: [dirname(process.execPath), env.PATH].filter(Boolean).join(":"), DIM_DATA_HOME: env.DIM_DATA_HOME, DIM_STATE_ROOT: env.DIM_STATE_ROOT, DIM_MANAGED_STATE_ROOT: env.DIM_MANAGED_STATE_ROOT, DIM_CONFIG_PATH: env.DIM_CONFIG_PATH, XDG_CONFIG_HOME: env.XDG_CONFIG_HOME })
    .filter((entry): entry is [string, string] => entry[1] !== undefined).map(([name, value]) => `Environment=${quote(`${name}=${value}`)}`).join("\n");
  const contents = `[Unit]\nDescription=DIM LLM router host gateway\nAfter=network.target dim-llm-router-operator.service\n\n[Service]\nType=simple\nExecStart=:${args.map(quote).join(" ")}\n${environment}\nRestart=on-failure\nRestartSec=3\nUMask=0077\n\n[Install]\nWantedBy=default.target\n`;
  const stage = `${unit}.tmp-${process.pid}`; await writeFile(stage, contents, { flag: "wx", mode: 0o600 }); await rename(stage, unit);
  await checked(run, "systemctl", ["--user", "daemon-reload"]);
  await checked(run, "systemctl", ["--user", "enable", "dim-llm-router-gateway.service"]);
  await checked(run, "systemctl", ["--user", "restart", "dim-llm-router-gateway.service"]);
  await checked(run, "systemctl", ["--user", "is-active", "--quiet", "dim-llm-router-gateway.service"]);
}
if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const bundle = process.argv[2]; if (!bundle || process.argv.length !== 3) throw new Error("Usage: node scripts/install-local-llm-gateway.ts ABSOLUTE_PACKAGE_ROOT");
  await restoreLocalLlmGateway(bundle);
}
