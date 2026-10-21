/** Repository-only setup. The production Web UI remains an optional package. */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { checked, command, type Command } from "./local-uninstall/command.ts";
import { metadata, object, readJson, text } from "./local-uninstall/files.ts";
import { removalPaths } from "./local-uninstall/paths.ts";
import { ownedWebUnit, webUnitPath } from "./local-uninstall/web-unit.ts";

async function privateDirectory(directory: string): Promise<void> {
  const stat = await metadata(directory);
  if (!stat) { await privateDirectory(dirname(directory)); await mkdir(directory, { mode: 0o700 }); return; }
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0) {
    throw new Error(`Web UI directory must be owned and not writable by others: ${directory}`);
  }
}
async function privateFile(file: string): Promise<boolean> {
  const stat = await metadata(file);
  if (!stat) return false;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600) {
    throw new Error(`Web UI file must be owned and mode 0600: ${file}`);
  }
  return true;
}
const quote = (value: string) => JSON.stringify(value.replaceAll("%", "%%"));
export async function configureLocalWeb(env: NodeJS.ProcessEnv = process.env, run: Command = command): Promise<void> {
  const paths = removalPaths(env), directory = join(paths.configuration, "web"), config = join(directory, "config.json");
  const executable = join(paths.data, "web/runtime/current/node_modules/.bin/dim-web");
  await privateDirectory(directory);
  if (!await privateFile(config)) {
    const cli = object(object(await readJson(paths.config)).cli);
    const operations = join(directory, "operations.json"), login = join(directory, "login.txt");
    // Preserve partial setup for inspection rather than overwriting credentials.
    if (await metadata(operations) || await metadata(login)) throw new Error(`incomplete Web UI setup; inspect ${directory} before retrying`);
    await writeFile(operations, JSON.stringify({ hosts: [{ id: "local", selector: "local", executable: text(cli.executable) }] }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    const output = await checked(run, process.execPath, [executable, "init-operations", operations, "--output", config, "--port", "9081"]);
    await writeFile(login, output, { flag: "wx", mode: 0o600 });
  }
  const saved = object(JSON.parse(await readFile(config, "utf8")));
  console.log(`[host] Web UI: ${text(saved.publicOrigin)} (login details: ${join(directory, "login.txt")})`);
  let systemd = false;
  try { systemd = (await run("systemctl", ["--user", "show-environment"])).status === 0; } catch { /* optional on hosts without systemd */ }
  if (!systemd) {
    console.log(`[host] no user systemd; start Web UI with: ${process.execPath} ${executable} serve ${config}`);
    return;
  }
  await ownedWebUnit(paths); // Refuse to replace a foreign unit.
  const unit = webUnitPath(paths);
  await privateDirectory(dirname(unit));
  // Host operations spawn the installed CLI, whose shebang must find this same
  // supported Node runtime even when the user service has a different PATH.
  const serviceEnv = { ...env, PATH: [dirname(process.execPath), env.PATH].filter(Boolean).join(":") };
  const environment = Object.entries(serviceEnv).filter(([name, value]) => value !== undefined && (name.startsWith("DIM_") || ["HOME", "PATH", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR"].includes(name)))
    .map(([name, value]) => `Environment=${quote(`${name}=${value}`)}`).join("\n");
  const content = `[Unit]\nDescription=DIM local Web UI\nAfter=network.target\n\n[Service]\nType=simple\nExecStart=:${[process.execPath, executable, "serve", config].map(quote).join(" ")}\n${environment}\nRestart=on-failure\nRestartSec=3\nUMask=0077\n\n[Install]\nWantedBy=default.target\n`;
  const stage = `${unit}.tmp-${process.pid}`;
  await writeFile(stage, content, { flag: "wx", mode: 0o600 });
  await rename(stage, unit);
  await checked(run, "systemctl", ["--user", "daemon-reload"]);
  await checked(run, "systemctl", ["--user", "enable", "dim-web.service"]);
  await checked(run, "systemctl", ["--user", "restart", "dim-web.service"]);
  await checked(run, "systemctl", ["--user", "is-active", "dim-web.service"]);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  configureLocalWeb().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
