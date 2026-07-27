import type {
  CaddyIngressConfig,
  CloudflareDnsProviderConfig
} from "@slop-lab/dim-external-url-contracts";

export const CADDY_VERSION = "2.11.4";
export const CADDY_CLOUDFLARE_VERSION = "v0.2.4";

export interface CaddyDeployment {
  dockerfile: string;
  caddyfile: string;
  compose: string;
  environmentExample: string;
}

export function renderCaddyDeployment(
  name: string,
  ingress: CaddyIngressConfig,
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
      - "80:80"
      - "443:443"
      - "443:443/udp"
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
  ingress: CaddyIngressConfig,
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
