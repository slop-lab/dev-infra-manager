import { describe, expect, it } from "vitest";
import {
  CADDY_CLOUDFLARE_VERSION,
  CADDY_INGRESS_DOCUMENTATION_URL,
  CADDY_VERSION,
  parseCaddyIngressArgument,
  renderCaddyDeployment
} from "../src/index.js";

describe("Caddy ingress deployment", () => {
  it("links argument validation errors to the Caddy ingress documentation", () => {
    expect(() => parseCaddyIngressArgument("")).toThrow(CADDY_INGRESS_DOCUMENTATION_URL);
    expect(() => parseCaddyIngressArgument("{}")).toThrow(CADDY_INGRESS_DOCUMENTATION_URL);
  });

  it("renders pinned Cloudflare DNS-01 and loopback-router forwarding", () => {
    const deployment = renderCaddyDeployment("public", {
      domain: "dev.example.com",
      listenHost: "127.0.0.1",
      listenPort: 9080,
      upstreamMode: "container-ip",
      provider: "cloudflare",
      acmeEmail: "ops@example.com"
    }, {
      driver: "cloudflare",
      zone: "example.com",
      recordType: "A",
      target: "203.0.113.10",
      proxied: false,
      credentialEnv: "CF_API_TOKEN"
    });
    expect(deployment.dockerfile).toContain(`caddy:${CADDY_VERSION}-builder-alpine`);
    expect(deployment.dockerfile).toContain(
      `github.com/caddy-dns/cloudflare@${CADDY_CLOUDFLARE_VERSION}`
    );
    expect(deployment.caddyfile).toContain("*.dev.example.com");
    expect(deployment.caddyfile).toContain("dns cloudflare {env.CF_API_TOKEN}");
    expect(deployment.caddyfile).toContain("reverse_proxy host.docker.internal:9080");
    expect(deployment.compose).toContain("host.docker.internal:host-gateway");
    expect(deployment.compose).not.toContain("replace-with-zone-scoped-token");
  });
});
