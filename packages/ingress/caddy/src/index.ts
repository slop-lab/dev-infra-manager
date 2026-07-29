import type {
  CloudflareDnsProviderConfig
} from "@slop-lab/dim-contracts-external-url";

export const CADDY_VERSION = "2.11.4";
export const CADDY_CLOUDFLARE_VERSION = "v0.2.4";

export interface CaddyDeployment {
  dockerfile: string;
  caddyfile: string;
  compose: string;
  environmentExample: string;
}

export interface CaddyIngressArgument {
  domain: string;
  listenHost: string;
  listenPort: number | "auto";
  publicListenHost?: string;
  upstreamMode?: "container-ip" | "container-dns";
  provider: string;
  acmeEmail?: string;
}

export function parseCaddyIngressArgument(argument: string): CaddyIngressArgument {
  let value: unknown;
  try {
    value = JSON.parse(argument);
  } catch {
    throw new Error("Caddy ingress argument must be valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Caddy ingress argument must be an object");
  }
  const input = value as Record<string, unknown>;
  if (typeof input.domain !== "string" || input.domain.length === 0) throw new Error("Caddy argument requires domain");
  if (typeof input.listenHost !== "string" || input.listenHost.length === 0) {
    throw new Error("Caddy argument requires listenHost");
  }
  if (input.listenPort !== "auto"
    && (!Number.isInteger(input.listenPort) || (input.listenPort as number) < 1 || (input.listenPort as number) > 65535)) {
    throw new Error("Caddy argument listenPort must be 'auto' or a port");
  }
  if (typeof input.provider !== "string" || input.provider.length === 0) throw new Error("Caddy argument requires provider");
  if (input.publicListenHost !== undefined && typeof input.publicListenHost !== "string") {
    throw new Error("Caddy argument publicListenHost must be a string");
  }
  if (input.upstreamMode !== undefined && input.upstreamMode !== "container-ip" && input.upstreamMode !== "container-dns") {
    throw new Error("Caddy argument upstreamMode must be container-ip or container-dns");
  }
  if (input.acmeEmail !== undefined && typeof input.acmeEmail !== "string") {
    throw new Error("Caddy argument acmeEmail must be a string");
  }
  return input as unknown as CaddyIngressArgument;
}

export function renderCaddyDeployment(
  name: string,
  ingress: CaddyIngressArgument & { listenPort: number },
  provider: CloudflareDnsProviderConfig
): CaddyDeployment {
  if (provider.driver !== "cloudflare") throw new Error("Caddy currently supports only the Cloudflare DNS provider");
  const service = `dim-caddy-${name}`;
  const email = ingress.acmeEmail ? `\n\temail ${ingress.acmeEmail}` : "";
  return {
    dockerfile: `FROM caddy:${CADDY_VERSION}-builder-alpine AS builder
RUN xcaddy build v${CADDY_VERSION} --with github.com/caddy-dns/cloudflare@${CADDY_CLOUDFLARE_VERSION}

FROM caddy:${CADDY_VERSION}-alpine
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
`,
    caddyfile: `{
\tadmin off${email}
}

*.${ingress.domain} {
\ttls {
\t\tdns cloudflare {env.${provider.credentialEnv}}
\t\tresolvers 1.1.1.1
\t}

\treverse_proxy host.docker.internal:${ingress.listenPort}
}
`,
    compose: `services:
  caddy:
    build:
      context: .
      dockerfile: Dockerfile
    container_name: ${service}
    restart: unless-stopped
    ports:
      - "${ingress.publicListenHost ? `${ingress.publicListenHost}:` : ""}80:80"
      - "${ingress.publicListenHost ? `${ingress.publicListenHost}:` : ""}443:443"
      - "${ingress.publicListenHost ? `${ingress.publicListenHost}:` : ""}443:443/udp"
    extra_hosts:
      - "host.docker.internal:host-gateway"
    environment:
      ${provider.credentialEnv}: \${${provider.credentialEnv}:?set ${provider.credentialEnv}}
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
      - caddy-config:/config

volumes:
  caddy-data:
  caddy-config:
`,
    environmentExample: `${provider.credentialEnv}=replace-with-zone-scoped-token\n`
  };
}

export async function verifyCaddyIngress(
  ingress: CaddyIngressArgument,
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  const response = await fetchImpl(`https://health.${ingress.domain}/`, {
    method: "HEAD",
    redirect: "manual"
  });
  if (response.status === 502 || response.status === 503 || response.status === 504) {
    throw new Error(`Caddy ingress '${ingress.domain}' cannot reach the DIM router`);
  }
  if (response.status >= 500) throw new Error(`Caddy ingress '${ingress.domain}' returned ${response.status}`);
}
