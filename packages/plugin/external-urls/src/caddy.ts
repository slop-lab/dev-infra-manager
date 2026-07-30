import type { ExternalUrlCaddyDnsModule } from "@slop-lab/dim-contracts-external-url";
import { parseRoutePolicy, type ExternalUrlRoutePolicyConfig } from "./routePolicy.js";

export const CADDY_VERSION = "2.11.4";
export const CADDY_INGRESS_DOCUMENTATION_URL =
  "https://github.com/slop-lab/dev-infra-manager/blob/main/docs/external-urls.md"
  + "#http-and-https-with-cloudflare-dns-and-caddy";

export interface CaddyDeployment {
  dockerfile: string;
  caddyfile: string;
  compose: string;
  environment: string;
}

export interface CaddyIngressArgument {
  domain: string;
  listenHost: string;
  listenPort: number | "auto";
  internalPort?: number;
  upstreamMode?: "container-ip" | "container-dns";
  dnsProvider: string;
  dnsArgument: string;
  acmeEmail?: string;
  routePolicy?: ExternalUrlRoutePolicyConfig;
}

export function parseCaddyIngressArgument(argument: string): CaddyIngressArgument {
  let value: unknown;
  try {
    value = JSON.parse(argument);
  } catch {
    throw caddyArgumentError("must be valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw caddyArgumentError("must be a JSON object");
  }
  const input = value as Record<string, unknown>;
  if (typeof input.domain !== "string" || input.domain.length === 0) {
    throw caddyArgumentError("requires string field 'domain'");
  }
  if (typeof input.listenHost !== "string" || input.listenHost.length === 0) {
    throw caddyArgumentError("requires string field 'listenHost'");
  }
  if (input.listenPort !== "auto"
    && (!Number.isInteger(input.listenPort) || (input.listenPort as number) < 1 || (input.listenPort as number) > 65535)) {
    throw caddyArgumentError("field 'listenPort' must be 'auto' or a port");
  }
  if (typeof input.dnsProvider !== "string" || input.dnsProvider.length === 0) {
    throw caddyArgumentError("requires string field 'dnsProvider'");
  }
  if (typeof input.dnsArgument !== "string") {
    throw caddyArgumentError("requires string field 'dnsArgument'");
  }
  if (input.internalPort !== undefined
    && (!Number.isInteger(input.internalPort) || (input.internalPort as number) < 1
      || (input.internalPort as number) > 65535)) {
    throw caddyArgumentError("stored field 'internalPort' must be a port");
  }
  if (input.upstreamMode !== undefined && input.upstreamMode !== "container-ip" && input.upstreamMode !== "container-dns") {
    throw caddyArgumentError("field 'upstreamMode' must be container-ip or container-dns");
  }
  if (input.acmeEmail !== undefined && typeof input.acmeEmail !== "string") {
    throw caddyArgumentError("field 'acmeEmail' must be a string");
  }
  return {
    ...input,
    ...(input.routePolicy === undefined ? {} : { routePolicy: parseRoutePolicy(input.routePolicy, caddyArgumentError) })
  } as unknown as CaddyIngressArgument;
}

function caddyArgumentError(detail: string): Error {
  return new Error(`Caddy ingress --argument ${detail}. See ${CADDY_INGRESS_DOCUMENTATION_URL}`);
}

function normalizeDomain(value: string): string {
  return value.toLowerCase().replace(/^\.+|\.+$/g, "");
}

export function renderCaddyDeployment(
  name: string,
  ingress: CaddyIngressArgument & { listenPort: number; internalPort: number },
  dns: ExternalUrlCaddyDnsModule
): CaddyDeployment {
  validateCaddyDnsModule(dns);
  const service = `dim-caddy-${name}`;
  const email = ingress.acmeEmail ? `\n\temail ${ingress.acmeEmail}` : "";
  const modules = dns.modules.map((module) => ` --with ${module}`).join("");
  const environment = Object.keys(dns.environment)
    .map((name) => `      ${name}: \${${name}:?set ${name}}`)
    .join("\n");
  return {
    dockerfile: `FROM caddy:${CADDY_VERSION}-builder-alpine AS builder
RUN xcaddy build v${CADDY_VERSION}${modules}

FROM caddy:${CADDY_VERSION}-alpine
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
`,
    caddyfile: `{
\tadmin off${email}
}

https://*.${ingress.domain}:${ingress.listenPort} {
\tbind ${ingress.listenHost}
\ttls {
\t\t${dns.directive}
\t\tresolvers 1.1.1.1
\t}

\treverse_proxy 127.0.0.1:${ingress.internalPort}
}
`,
    compose: `services:
  caddy:
    build:
      context: .
      dockerfile: Dockerfile
    container_name: ${service}
    restart: unless-stopped
    network_mode: host
    environment:
${environment}
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
      - caddy-config:/config

volumes:
  caddy-data:
  caddy-config:
`,
    environment: Object.entries(dns.environment)
      .map(([name, value]) => `${name}=${JSON.stringify(value)}\n`)
      .join("")
  };
}

function validateCaddyDnsModule(value: ExternalUrlCaddyDnsModule): void {
  if (!Array.isArray(value.modules) || value.modules.length === 0
    || !value.modules.every((module) => typeof module === "string" && module.length > 0 && !/\s/.test(module))) {
    throw new Error("DNS provider returned invalid Caddy module names");
  }
  if (typeof value.directive !== "string" || value.directive.length === 0 || /[\r\n]/.test(value.directive)) {
    throw new Error("DNS provider returned an invalid Caddy DNS-01 directive");
  }
  if (!value.environment || typeof value.environment !== "object"
    || !Object.entries(value.environment).every(([name, setting]) =>
      /^[A-Z_][A-Z0-9_]*$/.test(name) && typeof setting === "string")) {
    throw new Error("DNS provider returned invalid Caddy environment settings");
  }
}

export async function verifyCaddyIngress(
  ingress: CaddyIngressArgument,
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  if (ingress.listenPort === "auto") throw new Error("Caddy ingress has unresolved listenPort 'auto'");
  const authority = ingress.listenPort === 443
    ? `health.${ingress.domain}`
    : `health.${ingress.domain}:${ingress.listenPort}`;
  const response = await fetchImpl(`https://${authority}/`, {
    method: "HEAD",
    redirect: "manual"
  });
  if (response.status === 502 || response.status === 503 || response.status === 504) {
    throw new Error(`Caddy ingress '${ingress.domain}' cannot reach the DIM router`);
  }
  if (response.status >= 500) throw new Error(`Caddy ingress '${ingress.domain}' returned ${response.status}`);
}
