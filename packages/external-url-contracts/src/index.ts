import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type ExternalUrlScheme = "http" | "https";
export type ExternalUrlUpstreamMode = "container-dns" | "container-ip";

export interface CloudflareDnsProviderConfig {
  driver: "cloudflare";
  zone: string;
  recordType: "A" | "AAAA" | "CNAME";
  target: string;
  proxied: boolean;
  credentialEnv: string;
}

export type ExternalUrlProviderConfig = CloudflareDnsProviderConfig;

interface ExternalUrlIngressBase {
  description: string;
  scheme: ExternalUrlScheme;
  domain: string;
  port?: number;
  listenHost: string;
  listenPort: number;
  upstreamMode: ExternalUrlUpstreamMode;
}

export interface BuiltinHttpIngressConfig extends ExternalUrlIngressBase {
  driver: "builtin-http";
}

export interface CaddyIngressConfig extends ExternalUrlIngressBase {
  driver: "caddy";
  scheme: "https";
  provider: string;
  acmeEmail?: string;
}

export type ExternalUrlIngressConfig = BuiltinHttpIngressConfig | CaddyIngressConfig;

export interface ExternalUrlConfig {
  schemaVersion: 1;
  providers: Record<string, ExternalUrlProviderConfig>;
  ingresses: Record<string, ExternalUrlIngressConfig>;
}

export function emptyExternalUrlConfig(): ExternalUrlConfig {
  return { schemaVersion: 1, providers: {}, ingresses: {} };
}

export function externalUrlConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME ?? os.homedir();
  return path.resolve(
    env.DIM_EXTERNAL_URL_CONFIG
      ?? path.join(env.XDG_CONFIG_HOME ?? path.join(home, ".config"), "slop-lab", "external-urls.json")
  );
}

export async function readExternalUrlConfig(
  env: NodeJS.ProcessEnv = process.env,
  options: { required?: boolean } = {}
): Promise<ExternalUrlConfig> {
  const target = externalUrlConfigPath(env);
  try {
    return validateExternalUrlConfig(JSON.parse(await readFile(target, "utf8")) as unknown, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && !options.required) return emptyExternalUrlConfig();
    throw error;
  }
}

export async function writeExternalUrlConfig(
  config: ExternalUrlConfig,
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  const target = externalUrlConfigPath(env);
  const validated = validateExternalUrlConfig(config, target);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, target);
}

export function validateExternalUrlConfig(value: unknown, source = "external URL config"): ExternalUrlConfig {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.providers) || !isRecord(value.ingresses)) {
    throw new Error(`invalid external URL config at ${source}`);
  }
  const providers: Record<string, ExternalUrlProviderConfig> = {};
  for (const [name, provider] of Object.entries(value.providers)) {
    validateName(name, "provider");
    if (!isRecord(provider) || provider.driver !== "cloudflare") {
      throw new Error(`external URL provider '${name}' has an unsupported driver`);
    }
    if (!domain(provider.zone)) throw new Error(`Cloudflare provider '${name}' requires a valid zone`);
    if (provider.recordType !== "A" && provider.recordType !== "AAAA" && provider.recordType !== "CNAME") {
      throw new Error(`Cloudflare provider '${name}' requires recordType A, AAAA, or CNAME`);
    }
    if (typeof provider.target !== "string" || provider.target.length === 0) {
      throw new Error(`Cloudflare provider '${name}' requires a target`);
    }
    if (typeof provider.proxied !== "boolean") throw new Error(`Cloudflare provider '${name}' requires proxied`);
    if (typeof provider.credentialEnv !== "string" || !/^[A-Z_][A-Z0-9_]*$/.test(provider.credentialEnv)) {
      throw new Error(`Cloudflare provider '${name}' requires a credential environment variable`);
    }
    providers[name] = {
      driver: "cloudflare",
      zone: normalizeDomain(provider.zone),
      recordType: provider.recordType,
      target: provider.target,
      proxied: provider.proxied,
      credentialEnv: provider.credentialEnv
    };
  }

  const ingresses: Record<string, ExternalUrlIngressConfig> = {};
  for (const [name, ingress] of Object.entries(value.ingresses)) {
    validateName(name, "ingress");
    if (!isRecord(ingress) || (ingress.driver !== "builtin-http" && ingress.driver !== "caddy")) {
      throw new Error(`external URL ingress '${name}' has an unsupported driver`);
    }
    if (typeof ingress.description !== "string" || ingress.description.trim().length === 0) {
      throw new Error(`external URL ingress '${name}' requires a description`);
    }
    if (ingress.scheme !== "http" && ingress.scheme !== "https") {
      throw new Error(`external URL ingress '${name}' requires scheme http or https`);
    }
    if (!domain(ingress.domain)) throw new Error(`external URL ingress '${name}' requires a valid domain`);
    if (typeof ingress.listenHost !== "string" || ingress.listenHost.length === 0) {
      throw new Error(`external URL ingress '${name}' requires listenHost`);
    }
    const listenPort = validPort(ingress.listenPort, true, `${name}.listenPort`);
    const port = ingress.port === undefined ? undefined : validPort(ingress.port, false, `${name}.port`);
    if (ingress.upstreamMode !== "container-dns" && ingress.upstreamMode !== "container-ip") {
      throw new Error(`external URL ingress '${name}' requires a valid upstreamMode`);
    }
    const base = {
      description: ingress.description.trim(),
      scheme: ingress.scheme as ExternalUrlScheme,
      domain: normalizeDomain(ingress.domain),
      ...(port === undefined ? {} : { port }),
      listenHost: ingress.listenHost,
      listenPort,
      upstreamMode: ingress.upstreamMode as ExternalUrlUpstreamMode
    };
    if (ingress.driver === "caddy") {
      if (ingress.scheme !== "https") throw new Error(`Caddy ingress '${name}' must use https`);
      if (typeof ingress.provider !== "string" || !providers[ingress.provider]) {
        throw new Error(`Caddy ingress '${name}' references an unknown provider`);
      }
      if (ingress.acmeEmail !== undefined && typeof ingress.acmeEmail !== "string") {
        throw new Error(`Caddy ingress '${name}' has an invalid ACME email`);
      }
      ingresses[name] = {
        ...base,
        driver: "caddy",
        scheme: "https",
        provider: ingress.provider,
        ...(ingress.acmeEmail === undefined ? {} : { acmeEmail: ingress.acmeEmail })
      };
    } else {
      ingresses[name] = { ...base, driver: "builtin-http" };
    }
  }
  return { schemaVersion: 1, providers, ingresses };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateName(value: string, kind: string): void {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(value)) throw new Error(`invalid external URL ${kind} '${value}'`);
}

function domain(value: unknown): value is string {
  return typeof value === "string"
    && value.length <= 253
    && value.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
}

function normalizeDomain(value: string): string {
  return value.toLowerCase().replace(/^\.+|\.+$/g, "");
}

function validPort(value: unknown, zero: boolean, field: string): number {
  if (!Number.isInteger(value) || (value as number) < (zero ? 0 : 1) || (value as number) > 65_535) {
    throw new Error(`${field} must be between ${zero ? 0 : 1} and 65535`);
  }
  return value as number;
}
