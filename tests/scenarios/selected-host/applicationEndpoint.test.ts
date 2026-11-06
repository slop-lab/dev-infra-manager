import { createServer } from "node:http";
import { once } from "node:events";
import { expect, it } from "vitest";
import { expectSmokeApplication } from "./applicationEndpoint.js";

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
