import { describe, expect, it } from "vitest";
import {
  CADDY_CLOUDFLARE_VERSION,
  CADDY_INGRESS_DOCUMENTATION_URL,
  CADDY_VERSION,
  parseCaddyIngressArgument,
  renderCaddyDeployment
} from "../src/caddy.js";

describe("Caddy ingress deployment", () => {
  it("links argument validation errors to the Caddy ingress documentation", () => {
    expect(() => parseCaddyIngressArgument("")).toThrow(CADDY_INGRESS_DOCUMENTATION_URL);
    expect(() => parseCaddyIngressArgument("{}")).toThrow(CADDY_INGRESS_DOCUMENTATION_URL);
  });

  it("renders pinned Cloudflare DNS-01 and loopback-router forwarding", () => {
    const deployment = renderCaddyDeployment("public", {
      domain: "dev.example.com",
      listenHost: "100.64.0.10",
      listenPort: 8443,
      internalPort: 39080,
      upstreamMode: "container-ip",
      dnsProvider: "cloudflare",
      zone: "example.com",
      recordType: "A",
      target: "203.0.113.10",
      proxied: false,
      acmeEmail: "ops@example.com"
    }, {
      driver: "cloudflare",
      credential: "secret-token"
    });
    expect(deployment.dockerfile).toContain(`caddy:${CADDY_VERSION}-builder-alpine`);
    expect(deployment.dockerfile).toContain(
      `github.com/caddy-dns/cloudflare@${CADDY_CLOUDFLARE_VERSION}`
    );
    expect(deployment.caddyfile).toContain("*.dev.example.com");
    expect(deployment.caddyfile).toContain("dns cloudflare {env.CF_API_TOKEN}");
    expect(deployment.caddyfile).toContain("https://*.dev.example.com:8443");
    expect(deployment.caddyfile).toContain("bind 100.64.0.10");
    expect(deployment.caddyfile).toContain("reverse_proxy 127.0.0.1:39080");
    expect(deployment.compose).toContain("network_mode: host");
    expect(deployment.compose).not.toContain("80:80");
    expect(deployment.compose).not.toContain("replace-with-zone-scoped-token");
    expect(deployment.environment).toContain('CF_API_TOKEN="secret-token"');
  });
});
