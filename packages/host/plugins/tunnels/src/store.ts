import { constants } from "node:fs";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";

export interface TunnelRoute { protocol: "tcp" | "udp"; host: string; port: number }
export interface TunnelGrant { workspaceId: string; workspaceName: string; route: string; localPort: number }
export interface TunnelConfiguration {
  schemaVersion: 1;
  operator: { username: string; password: string };
  routes: Record<string, TunnelRoute>;
  grants: Record<string, TunnelGrant>;
}
export const namePattern = /^[a-z][a-z0-9-]{0,31}$/;
export const validPort = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 65535;
export const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
export function parseRoute(value: unknown): TunnelRoute {
  if (!object(value) || !["tcp", "udp"].includes(String(value.protocol)) || typeof value.host !== "string"
    || !value.host || value.host.length > 253 || /[\s\0/]/.test(value.host) || !validPort(value.port)) throw new Error("route requires protocol tcp|udp, a host and port 1..65535");
  return { protocol: value.protocol === "tcp" ? "tcp" : "udp", host: value.host, port: value.port };
}
export function parseConfiguration(value: unknown): TunnelConfiguration {
  if (!object(value) || value.schemaVersion !== 1 || !object(value.operator) || typeof value.operator.username !== "string"
    || !/^[a-zA-Z0-9._-]{1,64}$/.test(value.operator.username) || typeof value.operator.password !== "string" || value.operator.password.length < 24
    || !object(value.routes) || !object(value.grants)) throw new Error("invalid private tunnel configuration");
  const routes: Record<string, TunnelRoute> = {}, grants: Record<string, TunnelGrant> = {};
  for (const [name, route] of Object.entries(value.routes)) {
    if (!namePattern.test(name)) throw new Error("invalid route name");
    routes[name] = parseRoute(route);
  }
  for (const [token, grant] of Object.entries(value.grants)) {
    if (!/^[A-Za-z0-9_-]{40,128}$/.test(token) || !object(grant) || typeof grant.workspaceId !== "string" || !grant.workspaceId
      || typeof grant.workspaceName !== "string" || !grant.workspaceName || typeof grant.route !== "string"
      || !namePattern.test(grant.route) || !validPort(grant.localPort)) throw new Error("invalid workspace tunnel grant");
    grants[token] = { workspaceId: grant.workspaceId, workspaceName: grant.workspaceName, route: grant.route, localPort: grant.localPort };
  }
  return { schemaVersion: 1, operator: { username: value.operator.username, password: value.operator.password }, routes, grants };
}
export class TunnelStore {
  constructor(readonly file: string) {}
  async read(): Promise<TunnelConfiguration> {
    const handle = await open(this.file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || info.size > 1024 * 1024) throw new Error("tunnel configuration must be a private user-owned file (0600)");
      const value: unknown = JSON.parse(await handle.readFile("utf8"));
      return parseConfiguration(value);
    } finally { await handle.close(); }
  }
  async initialize(username: string): Promise<void> {
    const value = parseConfiguration({ schemaVersion: 1, operator: { username, password: randomBytes(32).toString("base64url") }, routes: {}, grants: {} });
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    await writeFile(this.file, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  }
  async update(change: (value: TunnelConfiguration) => void): Promise<TunnelConfiguration> {
    // Cooperating CLI and HTTP writers share one short, private filesystem lock.
    const lock = `${this.file}.lock`, deadline = Date.now() + 5000;
    while (true) {
      try { await mkdir(lock, { mode: 0o700 }); break; }
      catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
        if (Date.now() >= deadline) throw new Error(`tunnel configuration is locked; stop writers before removing ${lock}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      const value = await this.read(); change(value); parseConfiguration(value);
      await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      await rename(temporary, this.file); return value;
    } finally { await rm(temporary, { force: true }); await rm(lock, { recursive: true, force: true }); }
  }
}
