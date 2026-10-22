import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { expect, it } from "vitest";
import { activateNativeGitGeneration } from "../../../packages/control-plane/deployment/src/native-git-activation.js";

const generationId = "a".repeat(64);
const token = "private-test-activation-token";
async function server(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const service = createServer(handler);
  service.listen(0, "127.0.0.1");
  await once(service, "listening");
  const address = service.address();
  if (address === null || typeof address === "string") throw new Error("listener is missing");
  return { origin: `http://127.0.0.1:${address.port}`, async close() { service.closeAllConnections(); service.close(); await once(service, "close"); } };
}
function acknowledge(response: ServerResponse, value: unknown = { schemaVersion: 1, generationId, activated: true }) {
  response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

it("waits beyond two seconds for exact activation after repository reconciliation", async () => {
  const service = await server((request, response) => {
    expect(request.method).toBe("POST"); expect(request.url).toBe("/v1/activation");
    expect(request.headers.authorization).toBe(`Bearer ${token}`);
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.once("end", () => {
      expect(JSON.parse(Buffer.concat(chunks).toString("utf8"))).toEqual({ schemaVersion: 1, generationId });
      setTimeout(() => acknowledge(response), 2_100);
    });
  });
  try { await activateNativeGitGeneration({ ...service, generationId, token, timeoutMilliseconds: 120_000 }); }
  finally { await service.close(); }
});

it("keeps a finite activation deadline and closes the unsuccessful request", async () => {
  let aborted: Promise<unknown> | undefined;
  const service = await server((request) => { request.resume(); aborted = once(request.socket, "close"); });
  try {
    await expect(activateNativeGitGeneration({ ...service, generationId, token, timeoutMilliseconds: 50 })).rejects.toThrow("native Git activation failed");
    await aborted;
  } finally { await service.close(); }
});

it.each([
  { schemaVersion: 1, generationId: "b".repeat(64), activated: true },
  { schemaVersion: 1, generationId, activated: false },
  { schemaVersion: 1, generationId, activated: true, unexpected: true }
])("rejects an acknowledgment that does not exactly bind the active generation: %j", async (acknowledgment) => {
  const service = await server((_request, response) => acknowledge(response, acknowledgment));
  try { await expect(activateNativeGitGeneration({ ...service, generationId, token, timeoutMilliseconds: 1_000 })).rejects.toThrow("native Git activation failed"); }
  finally { await service.close(); }
});
