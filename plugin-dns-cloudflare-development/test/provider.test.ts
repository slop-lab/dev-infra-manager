import { describe, expect, it, vi } from "vitest";
import { registerPlugin } from "@slop-lab/dim-core";
import {
  EXTERNAL_URL_DNS_PROVIDER_EXTENSION,
  type ExternalUrlDnsProviderDriver
} from "@slop-lab/dim-contracts-external-url";
import cloudflarePlugin, {
  ensureCloudflareWildcard,
  parseCloudflareDnsProviderArgument,
  parseCloudflareDnsRecordArgument,
  verifyCloudflareWildcard
} from "../../plugin-dns-cloudflare/src/index.js";

const dnsProvider = {
  driver: "cloudflare" as const,
  credential: "secret-token"
};
const recordConfig = {
  zone: "example.com",
  recordType: "A" as const,
  value: "203.0.113.10",
  proxied: false
};

describe("Cloudflare DNS provider", () => {
  it("owns and normalizes its opaque argument", () => {
    expect(parseCloudflareDnsProviderArgument('{"credential":"secret-token"}')).toEqual({
      driver: "cloudflare",
      credential: "secret-token"
    });
    expect(parseCloudflareDnsRecordArgument(
      '{"zone":"example.com","value":"203.0.113.10","proxied":false}'
    )).toEqual(recordConfig);
    expect(parseCloudflareDnsRecordArgument(
      '{"zone":"example.com","value":"2001:db8::1"}'
    )).toMatchObject({ recordType: "AAAA", value: "2001:db8::1" });
    expect(parseCloudflareDnsRecordArgument(
      '{"zone":"example.com","value":"origin.example.net"}'
    )).toMatchObject({ recordType: "CNAME", value: "origin.example.net" });
  });

  it("registers as an External URL DNS provider extension", async () => {
    const registered = await registerPlugin(cloudflarePlugin);
    const driver = registered.host.extension<ExternalUrlDnsProviderDriver>(
      EXTERNAL_URL_DNS_PROVIDER_EXTENSION,
      "cloudflare"
    );
    expect(driver).toMatchObject({
      normalizeProviderArgument: expect.any(Function),
      normalizeRecordArgument: expect.any(Function),
      ensure: expect.any(Function),
      verify: expect.any(Function),
      remove: expect.any(Function),
      caddyDns01: expect.any(Function)
    });
    expect(driver?.caddyDns01('{"driver":"cloudflare","credential":"secret-token"}')).toEqual({
      modules: ["github.com/caddy-dns/cloudflare@v0.2.4"],
      directive: "dns cloudflare {env.CF_API_TOKEN}",
      environment: { CF_API_TOKEN: "secret-token" }
    });
    await registered.dispose();
  });

  it("creates a missing wildcard record", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response([{ id: "zone", name: "example.com" }]))
      .mockResolvedValueOnce(response([]))
      .mockResolvedValueOnce(response({
        id: "record",
        name: "*.dev.example.com",
        type: "A",
        content: "203.0.113.10",
        proxied: false
      }));
    const state = await ensureCloudflareWildcard(
      dnsProvider,
      recordConfig,
      "dev.example.com",
      { CF_API_TOKEN: "secret" },
      fetchMock
    );
    expect(state.recordId).toBe("record");
    expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({ method: "POST" });
  });

  it("rejects a wildcard record that drifted", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response([{ id: "zone", name: "example.com" }]))
      .mockResolvedValueOnce(response([{
        id: "record",
        name: "*.dev.example.com",
        type: "A",
        content: "198.51.100.2",
        proxied: false
      }]));
    await expect(verifyCloudflareWildcard(
      dnsProvider,
      recordConfig,
      "dev.example.com",
      { CF_API_TOKEN: "secret" },
      fetchMock
    )).rejects.toThrow(/does not match/);
  });

  it("uses an explicit API base for local integration tests", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response([{ id: "zone", name: "example.com" }]))
      .mockResolvedValueOnce(response([]))
      .mockResolvedValueOnce(response({
        id: "record",
        name: "*.dev.example.com",
        type: "A",
        content: "203.0.113.10",
        proxied: false
      }));
    await ensureCloudflareWildcard(
      dnsProvider,
      recordConfig,
      "dev.example.com",
      {
        CF_API_TOKEN: "secret",
        DIM_CLOUDFLARE_API_BASE: "http://127.0.0.1:8787/client/v4/"
      },
      fetchMock
    );
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "http://127.0.0.1:8787/client/v4/zones?name=example.com"
    );
  });
});

function response(result: unknown): Response {
  return new Response(JSON.stringify({ success: true, result }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}
