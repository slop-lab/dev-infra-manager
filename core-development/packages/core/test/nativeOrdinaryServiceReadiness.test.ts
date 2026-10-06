import { createServer } from "node:http";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkNativeOrdinaryServiceReadiness } from "../../../../core/packages/core/src/nativeOrdinaryServiceReadiness.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ordinary CI image-local readiness", () => {
  it("returns silently only for the exact authenticated readiness response", async () => {
    // Given
    const tokenPath = await tokenFile("ready-token");
    const server = createServer((request, response) => {
      expect(request.headers.authorization).toBe("Bearer ready-token");
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end('{"status":"ready","schemaVersion":1}');
    });
    const origin = await listen(server);

    // When / Then
    await expect(checkNativeOrdinaryServiceReadiness({ tokenPath, origin })).resolves.toBeUndefined();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it.each([
    [302, "application/json", "no-store", '{"status":"ready","schemaVersion":1}'],
    [200, "text/json", "no-store", '{"status":"ready","schemaVersion":1}'],
    [200, "application/json", "max-age=0", '{"status":"ready","schemaVersion":1}'],
    [200, "application/json", "no-store", '{"schemaVersion":1,"status":"ready","extra":true}']
  ])("rejects a non-exact response without disclosing the token", async (status, contentType, cacheControl, body) => {
    // Given
    const tokenPath = await tokenFile("private-ready-token");
    const server = createServer((_request, response) => {
      response.writeHead(status, { "content-type": contentType, "cache-control": cacheControl, location: "/readyz" });
      response.end(body);
    });
    const origin = await listen(server);

    // When / Then
    await expect(checkNativeOrdinaryServiceReadiness({ tokenPath, origin })).rejects.not.toThrow(/private-ready-token/);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});

async function tokenFile(token: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dim-ordinary-ready-"));
  roots.push(root);
  const path = join(root, "readiness.token");
  await writeFile(path, `${token}\n`);
  await chmod(path, 0o444);
  return path;
}

async function listen(server: ReturnType<typeof createServer>): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("test server address is unavailable");
  return `http://127.0.0.1:${address.port}`;
}
