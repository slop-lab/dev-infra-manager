import { createServer } from "node:http";
import { once } from "node:events";
import { expect, it } from "vitest";
import { expectSmokeApplication, startSmokeApplication } from "./applicationEndpoint.js";

it("verifies the real application schema and challenge through HTTP", async () => {
  const server = createServer((incoming, response) => {
    expect(incoming.url).toBe("/health"); response.end(JSON.stringify({ schemaVersion: 1, kind: "dim-smoke-application", challenge: "owned-run" }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    const address = server.address(); if (!address || typeof address === "string") throw new Error("missing listener");
    await expect(expectSmokeApplication(`http://127.0.0.1:${address.port}`, "owned-run")).resolves.toBeUndefined();
    await expect(expectSmokeApplication(`http://127.0.0.1:${address.port}`, "another-run")).rejects.toThrow("owned smoke application");
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

it("does not mistake an OpenCode health response for an application endpoint", async () => {
  const server = createServer((_request, response) => response.end('{"healthy":true,"version":"1.18.31"}'));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    const address = server.address(); if (!address || typeof address === "string") throw new Error("missing listener");
    await expect(expectSmokeApplication(`http://127.0.0.1:${address.port}`, "owned-run")).rejects.toThrow("owned smoke application");
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

it("consumes the actual public exposure envelope and verifies the owned HTTP response", async () => {
  const server = createServer((_request, response) => response.end(JSON.stringify({ schemaVersion: 1, kind: "dim-smoke-application", challenge: "owned-envelope" })));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    const address = server.address(); if (!address || typeof address === "string") throw new Error("missing listener");
    const url = `http://127.0.0.1:${address.port}`;
    const result = await startSmokeApplication({ workspace: { name: "dim-smoke-owned", id: "11111111-1111-4111-8111-111111111111" }, ingress: "practical", challenge: "owned-envelope",
      async run(step) { return { exitCode: 0, stderr: "", stdout: step !== "application external route" ? "" : JSON.stringify({ urls: [{
        id: "22222222-2222-4222-8222-222222222222", workspace: "dim-smoke-owned", ingress: "practical", subdomain: "owned",
        target: { containers: [], port: 3000, protocol: "http" }, url, permalink: `${url}/_dim/owned`, approval: "not-required", createdAt: "2026-11-06T15:00:00.000Z"
      }] }) }; } });
    expect(result).toBe(url);
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});
