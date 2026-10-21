import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { UserError } from "@slop-lab/dim-host-core";
export const gatewayImage = "docker.io/tailscale/tailscale:v1.102.2@sha256:321ce041508c19079b57a28b6666c8d81ab0b08accc0a2585b3ab663d557ac24";
export interface GatewayState { readonly schemaVersion: 1; readonly id: string; readonly image: string; readonly hostname: string; readonly loginServer?: string }
export const gatewayDirectory = (root: string) => join(root, "plugins/tailscale");
export function parseGatewayState(value: unknown): GatewayState {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new UserError("invalid Tailscale gateway state");
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some((key) => !["schemaVersion", "id", "image", "hostname", "loginServer"].includes(key)) || row.schemaVersion !== 1
    || typeof row.id !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(row.id)
    || typeof row.image !== "string" || !/^[a-z0-9][a-z0-9./:_-]*@sha256:[0-9a-f]{64}$/.test(row.image)
    || typeof row.hostname !== "string" || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(row.hostname)) throw new UserError("invalid Tailscale gateway identity");
  if (row.loginServer !== undefined) {
    if (typeof row.loginServer !== "string") throw new UserError("invalid Tailscale login server");
    const url = new URL(row.loginServer);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash || url.search) throw new UserError("invalid Tailscale login server");
  }
  return { schemaVersion: 1, id: row.id, image: row.image, hostname: row.hostname, ...(typeof row.loginServer === "string" ? { loginServer: row.loginServer } : {}) };
}
export async function readGatewayState(root: string): Promise<GatewayState | undefined> {
  const directory = gatewayDirectory(root), file = join(directory, "gateway.json");
  try {
    for (const path of [directory, file]) {
      const info = await lstat(path);
      if (info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || (path === file ? !info.isFile() : !info.isDirectory())) throw new UserError("Tailscale state must be private and operator-owned");
    }
    return parseGatewayState(JSON.parse(await readFile(file, "utf8")));
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
export async function configureGateway(root: string, options: { hostname?: string; loginServer?: string; image?: string } = {}): Promise<GatewayState> {
  const previous = await readGatewayState(root);
  const state = parseGatewayState({ schemaVersion: 1, id: previous?.id ?? randomUUID(), image: options.image ?? previous?.image ?? gatewayImage,
    hostname: options.hostname ?? previous?.hostname ?? "dim-gateway", ...((options.loginServer ?? previous?.loginServer) ? { loginServer: options.loginServer ?? previous?.loginServer } : {}) });
  const directory = gatewayDirectory(root); await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o700) throw new UserError("unsafe Tailscale gateway directory");
  const file = join(directory, "gateway.json"), stage = `${file}.${process.pid}.tmp`;
  await writeFile(stage, JSON.stringify(state), { mode: 0o600, flag: "wx" }); await rename(stage, file);
  return state;
}
export function gatewayNames(state: GatewayState) {
  const name = `dim-tailscale-${createHash("sha256").update(state.id).digest("hex").slice(0, 20)}`;
  return { container: name, network: `${name}-network`, volume: `${name}-state` };
}
export function gatewayLabels(state: GatewayState, resource: "gateway" | "network" | "auth"): Record<string, string> {
  return { "dim.managed": "true", "dim.owner": "dim", "dim.tailscale-id": state.id, "dim.resource": resource };
}
