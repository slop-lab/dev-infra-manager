import type { CloudflareDnsProviderConfig } from "@slop-lab/dim-plugin-external-url-contracts";

const defaultApiBase = "https://api.cloudflare.com/client/v4";

export interface CloudflareDnsRecordState {
  zoneId: string;
  recordId: string;
  name: string;
  type: "A" | "AAAA" | "CNAME";
  target: string;
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
  domain: string,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch
): Promise<CloudflareDnsRecordState> {
  const token = credential(provider, env);
  const apiBase = resolveApiBase(env);
  const zone = await findZone(apiBase, provider.zone, token, fetchImpl);
  const name = `*.${normalizeDomain(domain)}`;
  const existing = await findRecord(apiBase, zone.id, name, token, fetchImpl);
  const body = {
    type: provider.recordType,
    name,
    content: provider.target,
    proxied: provider.proxied,
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
  return state(zone.id, record, provider);
}

export async function verifyCloudflareWildcard(
  provider: CloudflareDnsProviderConfig,
  domain: string,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch
): Promise<CloudflareDnsRecordState> {
  const token = credential(provider, env);
  const apiBase = resolveApiBase(env);
  const zone = await findZone(apiBase, provider.zone, token, fetchImpl);
  const name = `*.${normalizeDomain(domain)}`;
  const record = await findRecord(apiBase, zone.id, name, token, fetchImpl);
  if (!record) throw new Error(`Cloudflare wildcard DNS record '${name}' is missing`);
  if (
    record.type !== provider.recordType
    || record.content !== provider.target
    || Boolean(record.proxied) !== provider.proxied
  ) {
    throw new Error(`Cloudflare wildcard DNS record '${name}' does not match DIM configuration`);
  }
  return state(zone.id, record, provider);
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
    credential(provider, env),
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

function credential(provider: CloudflareDnsProviderConfig, env: NodeJS.ProcessEnv): string {
  const token = env[provider.credentialEnv];
  if (!token) throw new Error(`Cloudflare credential environment variable ${provider.credentialEnv} is not set`);
  return token;
}

function resolveApiBase(env: NodeJS.ProcessEnv): string {
  return (env.DIM_CLOUDFLARE_API_BASE ?? defaultApiBase).replace(/\/+$/g, "");
}

function normalizeDomain(value: string): string {
  return value.toLowerCase().replace(/^\.+|\.+$/g, "");
}

function state(
  zoneId: string,
  record: CloudflareRecord,
  provider: CloudflareDnsProviderConfig
): CloudflareDnsRecordState {
  return {
    zoneId,
    recordId: record.id,
    name: record.name,
    type: provider.recordType,
    target: record.content,
    proxied: Boolean(record.proxied)
  };
}
