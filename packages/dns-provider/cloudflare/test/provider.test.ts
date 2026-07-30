import { describe, expect, it, vi } from "vitest";
import {
  ensureCloudflareWildcard,
  parseCloudflareDnsProviderArgument,
  verifyCloudflareWildcard
} from "../src/index.js";

const dnsProvider = {
  driver: "cloudflare" as const,
  credentialEnv: "CF_API_TOKEN"
};
const recordConfig = {
  zone: "example.com",
  recordType: "A" as const,
  target: "203.0.113.10",
  proxied: false
};

describe("Cloudflare DNS provider", () => {
  it("owns and normalizes its opaque argument", () => {
    expect(parseCloudflareDnsProviderArgument("")).toEqual({
      driver: "cloudflare",
      credentialEnv: "CF_API_TOKEN"
    });
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
