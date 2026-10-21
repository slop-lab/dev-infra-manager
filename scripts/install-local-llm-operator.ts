/** Restore the optional retained operator API during repository-only installation. */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { installLocalRuntime, localArtifacts, type InstallCommand } from "./local-source-runtime.ts";
import { checked, command, type Command } from "./local-uninstall/command.ts";
import { metadata, object } from "./local-uninstall/files.ts";
import { removalPaths } from "./local-uninstall/paths.ts";
import { llmOperatorUnitPath, ownedLlmOperatorUnit } from "./local-uninstall/llm-operator-unit.ts";

export const llmOperatorArtifacts = (manifest: unknown) => localArtifacts(manifest, ["@slop-lab/dim-control-plane-plugin-llm-router"]);
const quote = (value: string) => JSON.stringify(value.replaceAll("%", "%%"));
async function privateDirectory(directory: string): Promise<void> {
  const stat = await metadata(directory);
  if (!stat) { await privateDirectory(dirname(directory)); await mkdir(directory, { mode: 0o700 }); return; }
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0) throw new Error(`unsafe local LLM operator unit directory: ${directory}`);
}
export async function restoreLocalLlmOperator(bundle: string, env: NodeJS.ProcessEnv = process.env, run: Command = command, install?: InstallCommand): Promise<string | undefined> {
  const paths = removalPaths(env), configuration = join(paths.configuration, "llm/operator-service.json");
  const configStat = await metadata(configuration);
  if (!configStat) return;
  if (!configStat.isFile() || configStat.isSymbolicLink() || configStat.nlink !== 1 || configStat.uid !== process.getuid?.() || (configStat.mode & 0o777) !== 0o600 || configStat.size > 1024 * 1024) throw new Error("retained LLM operator configuration must be an owned mode-0600 regular file");
  object(JSON.parse(await readFile(configuration, "utf8")));
  await ownedLlmOperatorUnit(paths); // Refuse to replace a foreign listener's unit.
  const executable = await installLocalRuntime(bundle, paths.data, { component: "llm-operator", executable: "dim-control-plane-llm-router", packages: ["@slop-lab/dim-control-plane-plugin-llm-router"], ...(install ? { install } : {}) });
  let systemd = false;
  try { systemd = (await run("systemctl", ["--user", "show-environment"])).status === 0; } catch { /* A manual listener remains possible without systemd. */ }
  if (!systemd) {
    console.log(`[host] no user systemd; start retained LLM operator API with: ${process.execPath} ${executable} operator-serve ${configuration}`);
    return executable;
  }
  const unit = llmOperatorUnitPath(paths);
  await privateDirectory(dirname(unit));
  const environment = Object.entries({ HOME: env.HOME, PATH: [dirname(process.execPath), env.PATH].filter(Boolean).join(":") })
    .filter((entry): entry is [string, string] => entry[1] !== undefined).map(([name, value]) => `Environment=${quote(`${name}=${value}`)}`).join("\n");
  const contents = `[Unit]\nDescription=DIM LLM router operator API\nAfter=network.target\n\n[Service]\nType=simple\nExecStart=:${[process.execPath, executable, "operator-serve", configuration].map(quote).join(" ")}\n${environment}\nRestart=on-failure\nRestartSec=3\nUMask=0077\n\n[Install]\nWantedBy=default.target\n`;
  const stage = `${unit}.tmp-${process.pid}`;
  await writeFile(stage, contents, { flag: "wx", mode: 0o600 }); await rename(stage, unit);
  await checked(run, "systemctl", ["--user", "daemon-reload"]);
  await checked(run, "systemctl", ["--user", "enable", "dim-llm-router-operator.service"]);
  await checked(run, "systemctl", ["--user", "restart", "dim-llm-router-operator.service"]);
  await checked(run, "systemctl", ["--user", "is-active", "--quiet", "dim-llm-router-operator.service"]);
  console.log("[host] retained LLM router operator API restored");
  return executable;
}
if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const bundle = process.argv[2];
  if (!bundle || process.argv.length !== 3) throw new Error("Usage: node scripts/install-local-llm-operator.ts ABSOLUTE_PACKAGE_ROOT");
  await restoreLocalLlmOperator(bundle);
}
