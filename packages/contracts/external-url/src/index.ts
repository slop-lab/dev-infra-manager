import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type ExternalUrlScheme = "http" | "https";
export type ExternalUrlUpstreamMode = "container-dns" | "container-ip";
export const EXTERNAL_URL_DNS_PROVIDER_EXTENSION = "external-url.dns-provider";

export interface ExternalUrlDnsOperation {
  providerArgument: string;
  recordArgument: string;
  domain: string;
  env: NodeJS.ProcessEnv;
}

export interface ExternalUrlCaddyDnsModule {
  modules: readonly string[];
  directive: string;
  environment: Readonly<Record<string, string>>;
}

export interface ExternalUrlDnsProviderDriver {
  parseProviderArguments?(arguments_: readonly string[]): string;
  normalizeProviderArgument(argument: string): string;
  normalizeRecordArgument(argument: string): string;
  ensure(operation: ExternalUrlDnsOperation): Promise<void>;
  verify(operation: ExternalUrlDnsOperation): Promise<void>;
  remove(operation: ExternalUrlDnsOperation): Promise<void>;
  caddyDns01(providerArgument: string): ExternalUrlCaddyDnsModule;
}

export interface ExternalUrlDnsProviderConfig {
  driver: string;
  argument: string;
}

export interface ExternalUrlIngressConfig {
  driver: string;
  description: string;
  scheme: ExternalUrlScheme;
  argument: string;
}

export interface ExternalUrlConfig {
  schemaVersion: 1;
  dnsProviders: Record<string, ExternalUrlDnsProviderConfig>;
  ingresses: Record<string, ExternalUrlIngressConfig>;
}

export function emptyExternalUrlConfig(): ExternalUrlConfig {
  return { schemaVersion: 1, dnsProviders: {}, ingresses: {} };
}

export function externalUrlConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME ?? os.homedir();
  const configHome = env.XDG_CONFIG_HOME ?? path.join(home, ".config");
  return path.resolve(
    env.DIM_EXTERNAL_URL_CONFIG
      ?? path.join(configHome, "dim", "external-urls.json")
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
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.dnsProviders) || !isRecord(value.ingresses)) {
    throw new Error(`invalid external URL config at ${source}`);
  }
  const dnsProviders: Record<string, ExternalUrlDnsProviderConfig> = {};
  for (const [name, provider] of Object.entries(value.dnsProviders)) {
    validateName(name, "DNS provider");
    if (!isRecord(provider) || typeof provider.driver !== "string"
      || !/^[a-z0-9][a-z0-9-]*$/.test(provider.driver)) {
      throw new Error(`external URL DNS provider '${name}' requires a valid driver`);
    }
    if (typeof provider.argument !== "string") {
      throw new Error(`external URL DNS provider '${name}' requires a string argument`);
    }
    dnsProviders[name] = {
      driver: provider.driver,
      argument: provider.argument
    };
  }

  const ingresses: Record<string, ExternalUrlIngressConfig> = {};
  for (const [name, ingress] of Object.entries(value.ingresses)) {
    validateName(name, "ingress");
    if (!isRecord(ingress) || typeof ingress.driver !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(ingress.driver)) {
      throw new Error(`external URL ingress '${name}' requires a valid driver`);
    }
    if (typeof ingress.description !== "string" || ingress.description.trim().length === 0) {
      throw new Error(`external URL ingress '${name}' requires a description`);
    }
    if (ingress.scheme !== "http" && ingress.scheme !== "https") {
      throw new Error(`external URL ingress '${name}' requires scheme http or https`);
    }
    if (typeof ingress.argument !== "string") {
      throw new Error(`external URL ingress '${name}' requires a string argument`);
    }
    ingresses[name] = {
      driver: ingress.driver,
      description: ingress.description.trim(),
      scheme: ingress.scheme as ExternalUrlScheme,
      argument: ingress.argument
    };
  }
  return { schemaVersion: 1, dnsProviders, ingresses };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateName(value: string, kind: string): void {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(value)) throw new Error(`invalid external URL ${kind} '${value}'`);
}
