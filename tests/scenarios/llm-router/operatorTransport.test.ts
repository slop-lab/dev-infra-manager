import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createLlmRouterClient, LlmRouterResultUnavailableError } from "../../../packages/service-clients/llm-router/src/index.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture(mode: "rejected" | "lost") {
  const server = createServer((_request, response) => {
    if (mode === "rejected") {
      response.writeHead(409, { "content-type": "application/json" });
      response.end('{"error":"known rejection"}');
      return;
    }
    response.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing transport fixture address");
  const root = await mkdtemp(join(tmpdir(), "dim-llm-transport-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const keyFile = join(root, "operator.key");
  await writeFile(keyFile, randomBytes(32).toString("base64url"), { mode: 0o600 });
  const connectionFile = join(root, "operator.json");
  await writeFile(connectionFile, JSON.stringify({ schemaVersion: 1, endpoint: `http://127.0.0.1:${address.port}`, actorId: "operator", keyFile }), { mode: 0o600 });
  return createLlmRouterClient(connectionFile);
}

it("marks a dispatched operation result as unavailable when the response is lost", async () => {
  const client = await fixture("lost");

  const error = await client.invoke("project.state", { projectId: "example", action: "pause" }).catch((cause: unknown) => cause);

  expect(error).toBeInstanceOf(LlmRouterResultUnavailableError);
});

it("marks an upstream 503 unavailable even when response body cancellation fails", async () => {
  const client = await fixture("rejected");
  const fetchBeforeTest = globalThis.fetch;
  globalThis.fetch = async () => new Response(new ReadableStream({ cancel() { throw new Error("synthetic cancellation failure"); } }), { status: 503 });

  try {
    const error = await client.invoke("project.state", { projectId: "example", action: "pause" }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(LlmRouterResultUnavailableError);
    expect(error).toMatchObject({ cause: undefined });
  } finally {
    globalThis.fetch = fetchBeforeTest;
  }
});

it("keeps an explicit service rejection distinct from an unavailable result", async () => {
  const client = await fixture("rejected");

  const error = await client.invoke("project.state", { projectId: "example", action: "pause" }).catch((cause: unknown) => cause);

  expect(error).toMatchObject({ name: "Error", message: "LLM router operation failed (HTTP 409)" });
});
