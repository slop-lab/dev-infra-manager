import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { caddyIngressDriver, validateProvidedCaddyTls } from "../../../../packages/host/plugins/external-urls/src/caddyRuntime.js";
import {
  CADDY_INGRESS_DOCUMENTATION_URL,
  CADDY_VERSION,
  parseCaddyIngressArgument,
  renderCaddyDeployment
} from "../../../../packages/host/plugins/external-urls/src/caddy.js";

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

  it("uses existing DNS and read-only operator certificates without a DNS plugin or credentials", () => {
    const ingress = parseCaddyIngressArgument(JSON.stringify({
      domain: "dev.example.com", listenHost: "0.0.0.0", listenPort: 443,
      tlsCert: "/private certificates/wildcard.pem", tlsKey: "/private certificates/key.pem"
    }));
    expect(caddyIngressDriver.dependencies!(JSON.stringify(ingress))).toEqual([]);
    const deployment = renderCaddyDeployment("existing", { ...ingress, listenPort: 443 }, 39080);
    expect(deployment.dockerfile).toBe(`FROM caddy:${CADDY_VERSION}-alpine\n`);
    expect(deployment.caddyfile).toContain("tls /etc/caddy/tls/certificate.pem /etc/caddy/tls/private-key.pem");
    expect(deployment.compose).toContain('source: "/private certificates/key.pem"');
    expect(deployment.compose.match(/read_only: true/g)).toHaveLength(2);
    expect(deployment.compose).not.toContain("environment:");
    expect(deployment.environment).toBe("");
    for (const invalid of [
      { ...ingress, tlsKey: undefined }, { ...ingress, tlsCert: "relative.pem" },
      { ...ingress, dnsProvider: "cloudflare", dnsArgument: "{}" }
    ]) expect(() => parseCaddyIngressArgument(JSON.stringify(invalid))).toThrow();
  });

  it("validates the operator's wildcard certificate and private key before starting Caddy", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "dim-caddy-tls-"));
    try {
      const certificate = path.join(directory, "certificate.pem"), key = path.join(directory, "key.pem");
      execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2",
        "-subj", "/CN=*.dev.example.com", "-addext", "subjectAltName=DNS:*.dev.example.com",
        "-out", certificate, "-keyout", key], { stdio: "ignore" });
      const ingress = { domain: "dev.example.com", listenHost: "127.0.0.1", listenPort: 443,
        tlsCert: certificate, tlsKey: key };
      await expect(validateProvidedCaddyTls(ingress)).resolves.toBeUndefined();
      await expect(validateProvidedCaddyTls({ ...ingress, domain: "other.example.com" })).rejects.toThrow("wildcard certificate");
      await expect(validateProvidedCaddyTls({ ...ingress, tlsKey: certificate })).rejects.toThrow("matching private key");
      await expect(validateProvidedCaddyTls({ ...ingress, tlsKey: directory })).rejects.toThrow("readable PEM");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
