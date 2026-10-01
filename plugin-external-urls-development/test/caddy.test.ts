import { describe, expect, it } from "vitest";
import {
  CADDY_INGRESS_DOCUMENTATION_URL,
  CADDY_VERSION,
  parseCaddyIngressArgument,
  renderCaddyDeployment
} from "../../plugin-external-urls/src/caddy.js";

describe("Caddy ingress deployment", () => {
  it("links argument validation errors to the Caddy ingress documentation", () => {
    expect(() => parseCaddyIngressArgument("")).toThrow(CADDY_INGRESS_DOCUMENTATION_URL);
    expect(() => parseCaddyIngressArgument("{}")).toThrow(CADDY_INGRESS_DOCUMENTATION_URL);
  });

  it("normalizes and validates static upstream routes", () => {
    const parsed = parseCaddyIngressArgument(JSON.stringify({
      domain: "dev.example.com",
      listenHost: "127.0.0.1",
      listenPort: 443,
      dnsProvider: "cloudflare",
      dnsArgument: "{}",
      staticRoutes: [{ subdomain: "Git", upstream: "http://127.0.0.1:3300" }]
    }));
    expect(parsed.staticRoutes).toEqual([{ subdomain: "git", upstream: "http://127.0.0.1:3300" }]);
    expect(() => parseCaddyIngressArgument(JSON.stringify({
      ...parsed,
      staticRoutes: [{ subdomain: "git.dev", upstream: "http://127.0.0.1:3300" }]
    }))).toThrow("must be one DNS label");
    expect(() => parseCaddyIngressArgument(JSON.stringify({
      ...parsed,
      staticRoutes: [{ subdomain: "git", upstream: "http://user:secret@127.0.0.1:3300" }]
    }))).toThrow("without credentials");
  });

  it("renders pinned Cloudflare DNS-01 and loopback-router forwarding", () => {
    const deployment = renderCaddyDeployment("public", {
      domain: "dev.example.com",
      listenHost: "100.64.0.10",
      listenPort: 8443,
      upstreamMode: "container-ip",
      dnsProvider: "cloudflare",
      dnsArgument: "{}",
      acmeEmail: "ops@example.com",
      staticRoutes: [{ subdomain: "git", upstream: "http://127.0.0.1:3300" }]
    }, 39080, {
      modules: ["github.com/caddy-dns/cloudflare@v0.2.4"],
      directive: "dns cloudflare {env.CF_API_TOKEN}",
      environment: { CF_API_TOKEN: "secret-token" }
    });
    expect(deployment.dockerfile).toContain(`caddy:${CADDY_VERSION}-builder-alpine`);
    expect(deployment.dockerfile).toContain(
      "github.com/caddy-dns/cloudflare@v0.2.4"
    );
    expect(deployment.caddyfile).toContain("*.dev.example.com");
    expect(deployment.caddyfile).toContain("dns cloudflare {env.CF_API_TOKEN}");
    expect(deployment.caddyfile).toContain("https://*.dev.example.com:8443");
    expect(deployment.caddyfile).toContain("bind 100.64.0.10");
    expect(deployment.caddyfile).toContain("reverse_proxy 127.0.0.1:39080");
    expect(deployment.caddyfile).toContain("host git.dev.example.com");
    expect(deployment.caddyfile).toContain("reverse_proxy http://127.0.0.1:3300");
    expect(deployment.caddyfile.indexOf("host git.dev.example.com"))
      .toBeLessThan(deployment.caddyfile.indexOf("reverse_proxy 127.0.0.1:39080"));
    expect(deployment.compose).toContain("network_mode: host");
    expect(deployment.compose).not.toContain("80:80");
    expect(deployment.compose).not.toContain("replace-with-zone-scoped-token");
    expect(deployment.environment).toContain('CF_API_TOKEN="secret-token"');
  });
});
