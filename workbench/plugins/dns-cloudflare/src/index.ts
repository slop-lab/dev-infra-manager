import { isIP } from "node:net";
import {
  DIM_PLUGIN_API_VERSION,
  type DimPlugin
} from "@slop-lab/dim-core";
import {
  EXTERNAL_URL_DNS_PROVIDER_EXTENSION,
  type ExternalUrlDnsProviderDriver,
  type ExternalUrlDnsOperation
} from "@slop-lab/dim-contracts-external-url";

const defaultCloudflareApiBase = "https://api.cloudflare.com/client/v4";
export const CLOUDFLARE_DNS_PROVIDER_DOCUMENTATION_URL =
  "https://github.com/slop-lab/dev-infra-manager/blob/main/docs/external-urls.md"
  + "#http-and-https-with-cloudflare-dns-and-caddy";

export interface CloudflareDnsProviderConfig {
  driver: "cloudflare";
  credential: string;
}

export interface CloudflareDnsRecordConfig {
  zone: string;
  recordType: "A" | "AAAA" | "CNAME";
  value: string;
  proxied: boolean;
}

export function parseCloudflareDnsRecordArgument(argument: string): CloudflareDnsRecordConfig {
  let value: unknown;
  try {
    value = JSON.parse(argument);
  } catch {
    throw cloudflareRecordArgumentError("must be valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw cloudflareRecordArgumentError("must be a JSON object");
  }
  const input = value as Record<string, unknown>;
  if (typeof input.zone !== "string" || normalizeDomain(input.zone).length === 0) {
    throw cloudflareRecordArgumentError("requires string field 'zone'");
  }
  if (typeof input.value !== "string" || input.value.length === 0) {
    throw cloudflareRecordArgumentError("requires string field 'value'");
  }
  const addressFamily = isIP(input.value);
  if (input.proxied !== undefined && typeof input.proxied !== "boolean") {
    throw cloudflareRecordArgumentError("field 'proxied' must be boolean");
  }
  return {
    zone: normalizeDomain(input.zone),
    recordType: addressFamily === 4 ? "A" : addressFamily === 6 ? "AAAA" : "CNAME",
    value: input.value,
    proxied: input.proxied ?? false
  };
}

function cloudflareRecordArgumentError(detail: string): Error {
  return new Error(`Cloudflare DNS record argument ${detail}. See ${CLOUDFLARE_DNS_PROVIDER_DOCUMENTATION_URL}`);
}

export function parseCloudflareDnsProviderArgument(argument: string): CloudflareDnsProviderConfig {
  let value: unknown;
  try {
    value = JSON.parse(argument);
  } catch {
    throw cloudflareArgumentError("must be valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw cloudflareArgumentError("must be a JSON object");
  }
  const input = value as Record<string, unknown>;
  if (typeof input.credential !== "string" || input.credential.length === 0) {
    throw cloudflareArgumentError("requires string field 'credential'");
  }
  return {
    driver: "cloudflare",
    credential: input.credential
  };
}

function cloudflareArgumentError(detail: string): Error {
  return new Error(`Cloudflare DNS provider arguments ${detail}. See ${CLOUDFLARE_DNS_PROVIDER_DOCUMENTATION_URL}`);
}

export interface CloudflareDnsRecordState {
  zoneId: string;
  recordId: string;
  name: string;
  type: "A" | "AAAA" | "CNAME";
  value: string;
  proxied: boolean;
}

interface CloudflareResult<T> {
  success: boolean;
  errors?: Array<{ code?: number; message?: string }>;
  result: T;
}

interface CloudflareZone {
  id: string;
  name: string;
}

interface CloudflareRecord {
  id: string;
  name: string;
  type: string;
  content: string;
  proxied?: boolean;
}

export async function ensureCloudflareWildcard(
  provider: CloudflareDnsProviderConfig,
  recordConfig: CloudflareDnsRecordConfig,
  domain: string,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch
): Promise<CloudflareDnsRecordState> {
  const token = credential(provider);
  const apiBase = resolveApiBase(env);
  const zone = await findZone(apiBase, recordConfig.zone, token, fetchImpl);
  const name = `*.${normalizeDomain(domain)}`;
  const existing = await findRecord(apiBase, zone.id, name, token, fetchImpl);
  const body = {
    type: recordConfig.recordType,
    name,
    content: recordConfig.value,
    proxied: recordConfig.proxied,
    ttl: 1
  };
  const record = existing
    ? await request<CloudflareRecord>(
      `${apiBase}/zones/${zone.id}/dns_records/${existing.id}`,
      token,
      fetchImpl,
      { method: "PUT", body: JSON.stringify(body) }
    )
    : await request<CloudflareRecord>(
      `${apiBase}/zones/${zone.id}/dns_records`,
      token,
      fetchImpl,
      { method: "POST", body: JSON.stringify(body) }
    );
  return state(zone.id, record, recordConfig);
}

export async function verifyCloudflareWildcard(
  provider: CloudflareDnsProviderConfig,
  recordConfig: CloudflareDnsRecordConfig,
  domain: string,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch
): Promise<CloudflareDnsRecordState> {
  const token = credential(provider);
  const apiBase = resolveApiBase(env);
  const zone = await findZone(apiBase, recordConfig.zone, token, fetchImpl);
  const name = `*.${normalizeDomain(domain)}`;
  const record = await findRecord(apiBase, zone.id, name, token, fetchImpl);
  if (!record) throw new Error(`Cloudflare wildcard DNS record '${name}' is missing`);
  if (
    record.type !== recordConfig.recordType
    || record.content !== recordConfig.value
    || Boolean(record.proxied) !== recordConfig.proxied
  ) {
    throw new Error(`Cloudflare wildcard DNS record '${name}' does not match DIM configuration`);
  }
  return state(zone.id, record, recordConfig);
}

export async function removeCloudflareWildcard(
  provider: CloudflareDnsProviderConfig,
  record: CloudflareDnsRecordState,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  const apiBase = resolveApiBase(env);
  await request<unknown>(
    `${apiBase}/zones/${record.zoneId}/dns_records/${record.recordId}`,
    credential(provider),
    fetchImpl,
    { method: "DELETE" }
  );
}

async function findZone(
  apiBase: string,
  zone: string,
  token: string,
  fetchImpl: typeof fetch
): Promise<CloudflareZone> {
  const result = await request<CloudflareZone[]>(
    `${apiBase}/zones?name=${encodeURIComponent(normalizeDomain(zone))}`,
    token,
    fetchImpl
  );
  if (result.length !== 1) throw new Error(`expected exactly one Cloudflare zone named '${zone}'`);
  return result[0] as CloudflareZone;
}

async function findRecord(
  apiBase: string,
  zoneId: string,
  name: string,
  token: string,
  fetchImpl: typeof fetch
): Promise<CloudflareRecord | undefined> {
  const records = await request<CloudflareRecord[]>(
    `${apiBase}/zones/${zoneId}/dns_records?name=${encodeURIComponent(name)}`,
    token,
    fetchImpl
  );
  if (records.length > 1) throw new Error(`multiple Cloudflare DNS records exist for '${name}'`);
  return records[0];
}

async function request<T>(
  url: string,
  token: string,
  fetchImpl: typeof fetch,
  init: RequestInit = {}
): Promise<T> {
  const response = await fetchImpl(url, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(init.headers ?? {})
    }
  });
  let payload: CloudflareResult<T>;
  try {
    payload = await response.json() as CloudflareResult<T>;
  } catch {
    throw new Error(`Cloudflare API returned invalid JSON (${response.status})`);
  }
  if (!response.ok || !payload.success) {
    const detail = payload.errors?.map((error) => error.message ?? String(error.code ?? "unknown")).join("; ");
    throw new Error(`Cloudflare API request failed (${response.status})${detail ? `: ${detail}` : ""}`);
  }
  return payload.result;
}

function credential(provider: CloudflareDnsProviderConfig): string {
  return provider.credential;
}

function resolveApiBase(env: NodeJS.ProcessEnv): string {
  return (env.DIM_CLOUDFLARE_API_BASE ?? defaultCloudflareApiBase).replace(/\/+$/g, "");
}

function normalizeDomain(value: string): string {
  return value.toLowerCase().replace(/^\.+|\.+$/g, "");
}

function state(
  zoneId: string,
  record: CloudflareRecord,
  recordConfig: CloudflareDnsRecordConfig
): CloudflareDnsRecordState {
  return {
    zoneId,
    recordId: record.id,
    name: record.name,
    type: recordConfig.recordType,
    value: record.content,
    proxied: Boolean(record.proxied)
  };
}

export const cloudflareDnsProviderDriver: ExternalUrlDnsProviderDriver = {
  parseProviderArguments(arguments_) {
    let credential: string | undefined;
    for (let index = 0; index < arguments_.length; index += 1) {
      const argument = arguments_[index];
      if (argument === "--credential") {
        credential = arguments_[++index];
        if (!credential) throw cloudflareArgumentError("--credential requires a value");
      } else {
        throw cloudflareArgumentError(`unknown argument '${argument}'`);
      }
    }
    if (!credential) throw cloudflareArgumentError("requires --credential");
    return JSON.stringify({ credential });
  },
  normalizeProviderArgument(argument) {
    return JSON.stringify(parseCloudflareDnsProviderArgument(argument));
  },
  normalizeRecordArgument(argument) {
    return JSON.stringify(parseCloudflareDnsRecordArgument(argument));
  },
  async ensure(operation) {
    await ensureCloudflareWildcard(...operationArguments(operation));
  },
  async verify(operation) {
    await verifyCloudflareWildcard(...operationArguments(operation));
  },
  async remove(operation) {
    const [provider, record, domain, env] = operationArguments(operation);
    await removeCloudflareWildcard(
      provider,
      await verifyCloudflareWildcard(provider, record, domain, env),
      env
    );
  },
  caddyDns01(providerArgument) {
    return {
      modules: ["github.com/caddy-dns/cloudflare@v0.2.4"],
      directive: "dns cloudflare {env.CF_API_TOKEN}",
      environment: {
        CF_API_TOKEN: parseCloudflareDnsProviderArgument(providerArgument).credential
      }
    };
  }
};

function operationArguments(operation: ExternalUrlDnsOperation): [
  CloudflareDnsProviderConfig,
  CloudflareDnsRecordConfig,
  string,
  NodeJS.ProcessEnv
] {
  return [
    parseCloudflareDnsProviderArgument(operation.providerArgument),
    parseCloudflareDnsRecordArgument(operation.recordArgument),
    operation.domain,
    operation.env
  ];
}

const plugin: DimPlugin = {
  name: "@slop-lab/dim-plugin-dns-cloudflare",
  apiVersion: DIM_PLUGIN_API_VERSION,
  register(host) {
    host.registerExtension(
      EXTERNAL_URL_DNS_PROVIDER_EXTENSION,
      "cloudflare",
      cloudflareDnsProviderDriver
    );
  }
};

export default plugin;
