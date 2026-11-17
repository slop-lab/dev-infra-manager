/** Guest-side entrypoint: runs as root (via `sudo -n node`) inside the workspace container.
 * The host controller runs unprivileged and never binds a port itself; see nameServiceAttachment.ts. */
import { constants } from "node:fs";
import { access, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createNameResolver } from "./nameResolver.js";
import { createNameIngress } from "./nameIngress.js";
import { flattenNameTable, parseNameTable } from "./nameTable.js";

/** Fixed and stable so a registered upstream can be advertised as 'http://NAME.dim.internal:PORT/' forever. */
export const DIM_NAME_SERVICE_INGRESS_PORT = 8053;
const DEFAULT_RESOLV_CONF = "/etc/resolv.conf";
const MARKER = "# managed by dim-name-service; do not edit\n";
const POLL_INTERVAL_MS = 250;

export interface GuestNameServiceOptions {
  readonly resolvConfPath?: string;
  /** Test-only: production always binds 53 (requires the root this process runs as via sudo). */
  readonly resolverPort?: number;
}
export interface GuestNameServiceHandle { readonly resolverPort: number; readonly ingressPort: number; close(): Promise<void> }

function backupPath(configPath: string): string { return path.join(path.dirname(configPath), "resolv-conf.backup"); }

async function exists(file: string): Promise<boolean> {
  try { await access(file, constants.F_OK); return true; } catch { return false; }
}

/** Only real, non-loopback upstreams are forwarded to; the swapped resolv.conf must never be read back as "original". */
async function readUpstreamResolvers(resolvConfPath: string): Promise<readonly string[]> {
  let text: string;
  try { text = await readFile(resolvConfPath, "utf8"); } catch { return []; }
  if (text.startsWith(MARKER)) return []; // a crashed prior run left its own override in place; nothing real to read
  return [...text.matchAll(/^\s*nameserver\s+(\S+)/gm)].map((match) => match[1]!).filter((server) => server !== "127.0.0.1" && server !== "::1");
}

/** In-place content replace, preserving the inode Docker may have bind-mounted at this path. */
async function writeInPlace(file: string, contents: string): Promise<void> {
  const handle = await open(file, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const bytes = Buffer.from(contents);
    await handle.write(bytes, 0, bytes.length, 0);
    await handle.truncate(bytes.length);
    await handle.sync();
  } finally { await handle.close(); }
}

/** Captures the pre-existing resolver config exactly once; a later crash-and-resume must not capture our own override. */
async function captureOriginalResolvConf(configPath: string, resolvConfPath: string): Promise<void> {
  const backup = backupPath(configPath);
  if (await exists(backup)) return;
  let current: string;
  try { current = await readFile(resolvConfPath, "utf8"); } catch { return; }
  if (current.startsWith(MARKER)) return;
  const temporary = `${backup}.tmp`;
  try { await writeFile(temporary, current, { mode: 0o600, flag: "wx" }); await rename(temporary, backup); }
  finally { await rm(temporary, { force: true }); }
}

/** Preserves the original `search`/`options`/comment lines; only the nameserver list is swapped to our resolver. */
async function applyResolvConf(configPath: string, resolvConfPath: string): Promise<void> {
  let preserved = "";
  try {
    const original = await readFile(backupPath(configPath), "utf8");
    preserved = original.split(/\r?\n/).filter((line) => !/^\s*nameserver\s+/.test(line)).join("\n").replace(/\n+$/, "");
  } catch { /* no captured original: fall back to just our nameserver */ }
  await writeInPlace(resolvConfPath, `${MARKER}${preserved ? `${preserved}\n` : ""}nameserver 127.0.0.1\n`);
}

/** Best-effort: never leave the guest without a working nameserver, even if this step itself fails. */
async function revertResolvConf(configPath: string, resolvConfPath: string): Promise<void> {
  const backup = backupPath(configPath);
  let original: string;
  try { original = await readFile(backup, "utf8"); } catch { return; }
  try { await writeInPlace(resolvConfPath, original); await rm(backup, { force: true }); } catch { /* next run recaptures from whatever is there */ }
}

async function readTable(configPath: string) {
  return parseNameTable(JSON.parse(await readFile(configPath, "utf8")));
}

/** Testable core: no signal handling, no process exit. The CLI entrypoint below wires those. */
export async function startGuestNameService(configPath: string, options: GuestNameServiceOptions = {}): Promise<GuestNameServiceHandle> {
  if (!path.isAbsolute(configPath)) throw new Error("the name service configuration path must be absolute");
  const resolvConfPath = options.resolvConfPath ?? DEFAULT_RESOLV_CONF;
  const upstreams = await readUpstreamResolvers(resolvConfPath);
  let upstreamMap = flattenNameTable(await readTable(configPath));
  let names = new Set(upstreamMap.keys());

  // Bound to loopback only: Phase 1 serves the top-level guest. Nested-container
  // reachability is executionRouting's job (Phase 2); widening the bind is its call.
  const resolver = await createNameResolver({ listen: "127.0.0.1", port: options.resolverPort ?? 53, gateway: "127.0.0.1", names: () => names, upstreams: () => upstreams });
  try {
    const ingress = await createNameIngress({ listen: "127.0.0.1", port: DIM_NAME_SERVICE_INGRESS_PORT, upstreams: () => upstreamMap });
    try {
      await captureOriginalResolvConf(configPath, resolvConfPath);
      await applyResolvConf(configPath, resolvConfPath);
    } catch (error) { resolver.close(); ingress.close(); throw error; }

    let closing = false;
    let reloading = false;
    const timer = setInterval(() => {
      if (reloading) return; reloading = true;
      void readTable(configPath).then((next) => { upstreamMap = flattenNameTable(next); names = new Set(upstreamMap.keys()); })
        .catch(() => { /* a transient read failure keeps serving the last-known-good table */ })
        .finally(() => { reloading = false; });
    }, POLL_INTERVAL_MS);
    return {
      resolverPort: resolver.udpPort, ingressPort: ingress.port,
      async close() {
        if (closing) return; closing = true;
        clearInterval(timer);
        resolver.close(); ingress.close();
        await Promise.all([resolver.closed, ingress.closed]);
        await revertResolvConf(configPath, resolvConfPath);
      }
    };
  } catch (error) { resolver.close(); throw error; }
}

/** Separate entrypoint: only an explicit absolute config path from `dim-workspace service register` starts this. */
export async function runGuestNameService(configPath: string): Promise<void> {
  const handle = await startGuestNameService(configPath);
  const stop = () => { void handle.close().then(() => process.exit(0)); };
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const configPath = process.argv[2];
  if (!configPath) { console.error("usage: node nameServiceGuestMain.js CONFIG_PATH"); process.exitCode = 2; }
  else void runGuestNameService(configPath).catch((error: unknown) => { console.error(error instanceof Error ? error.message : "the workspace name service failed"); process.exitCode = 1; });
}
