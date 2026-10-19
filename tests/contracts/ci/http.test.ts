import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { globalAgent } from "node:https";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeNativeGitAdmissionHttpClient }
  from "../../../packages/contracts/ci/src/http.js";
import { nativeTlsServer, type NativeTlsFixture } from "./tlsFixture.js";

const fixtures: NativeTlsFixture[] = [];
const originalCa = globalAgent.options.ca;

afterEach(async () => {
  if (originalCa === undefined) delete globalAgent.options.ca;
  else globalAgent.options.ca = originalCa;
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
});

describe("native HTTPS transport", () => {
  it("uses verified TLS for authenticated JSON requests", async () => {
    // Given
    const authorization = `Basic ${Buffer.from("reader:secret").toString("base64")}`;
    const tls = await nativeTlsServer((request, response) => {
      expect(request.headers.authorization).toBe(authorization);
      response.writeHead(request.url === "/v1/candidate-read-leases" ? 201 : 200, {
        "content-type": "application/json",
        "cache-control": "no-store"
      }).end(request.url === "/v1/candidate-read-leases"
        ? JSON.stringify({ requestId: "request-a", serviceId: "native-main",
          username: "lease-a", password: "lease-secret", expiresAt: 123 })
        : JSON.stringify({ ok: true }));
    });
    fixtures.push(tls);
    globalAgent.options.ca = tls.ca;
    const client = createNodeNativeGitAdmissionHttpClient();

    // When
    const response = await client.request({ endpoint: tls.origin, method: "GET", path: "/identity",
      authorization, signal: AbortSignal.timeout(5_000) });


    // Then
    expect(response).toMatchObject({ statusCode: 200, contentType: "application/json", cacheControl: "no-store" });
    expect(JSON.parse(response.body.toString("utf8"))).toEqual({ ok: true });
  });

  it("rejects unknown authorities and wrong hostnames", async () => {
    // Given
    const trusted = await nativeTlsServer(jsonResponse);
    const untrusted = await nativeTlsServer(jsonResponse);
    fixtures.push(trusted, untrusted);
    globalAgent.options.ca = trusted.ca;
    const client = createNodeNativeGitAdmissionHttpClient();
    const input = (endpoint: string) => ({ endpoint, method: "GET" as const, path: "/identity",
      authorization: "Basic fixture", signal: AbortSignal.timeout(5_000) });

    // When / Then
    await expect(client.request(input(untrusted.origin))).rejects.toThrow();
    await expect(client.request(input(trusted.wrongHostnameOrigin))).rejects.toThrow();
  });

  it("keeps loopback HTTP working and never follows redirects with authorization", async () => {
    // Given
    let redirectedAuthorization: string | undefined;
    const target = createServer((request, response) => {
      redirectedAuthorization = request.headers.authorization;
      response.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    const targetAddress = target.address();
    if (targetAddress === null || typeof targetAddress === "string") throw new TypeError("redirect target did not bind TCP");
    const source = createServer((_request, response) => response.writeHead(307, {
      location: `http://127.0.0.1:${targetAddress.port}/stolen`
    }).end());
    await new Promise<void>((resolve) => source.listen(0, "127.0.0.1", resolve));
    const sourceAddress = source.address();
    if (sourceAddress === null || typeof sourceAddress === "string") throw new TypeError("HTTP fixture did not bind TCP");
    const client = createNodeNativeGitAdmissionHttpClient();
    const ipv6 = createServer(jsonResponse);
    await new Promise<void>((resolve, reject) => {
      ipv6.once("error", reject);
      ipv6.listen(0, "::1", () => {
        ipv6.off("error", reject);
        resolve();
      });
    });
    const ipv6Address = ipv6.address();
    if (ipv6Address === null || typeof ipv6Address === "string") throw new TypeError("IPv6 fixture did not bind TCP");

    // When
    const response = await client.request({ endpoint: `http://127.0.0.1:${sourceAddress.port}`,
      method: "GET", path: "/identity", authorization: "Basic must-not-leak",
      signal: AbortSignal.timeout(5_000) });
    const ipv6Response = await client.request({ endpoint: `http://[::1]:${ipv6Address.port}`,
      method: "GET", path: "/identity", authorization: "Basic ipv6",
      signal: AbortSignal.timeout(5_000) });

    // Then
    expect(response.statusCode).toBe(307);
    expect(ipv6Response.statusCode).toBe(200);
    expect(redirectedAuthorization).toBeUndefined();
    await Promise.all([close(source), close(target), close(ipv6)]);
  });
});

function jsonResponse(_request: IncomingMessage, response: ServerResponse): void {
  response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end("{}");
}

function close(server: import("node:http").Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
}
