import { createServer } from "node:http";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkNativeGitServiceReadiness } from "../../../../core/packages/native-git/src/serviceReadiness.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("native Git image-local readiness", () => {
  it("uses its mounted token and accepts only the exact local readiness response", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "dim-native-ready-"));
    roots.push(root);
    const tokenPath = join(root, "readiness.token");
    await writeFile(tokenPath, "native-ready-token\n");
    await chmod(tokenPath, 0o444);
    const server = createServer((request, response) => {
      expect(request.url).toBe("/readyz");
      expect(request.headers.authorization).toBe("Bearer native-ready-token");
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end('{"status":"ready","schemaVersion":1}');
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("test server address is unavailable");

    // When / Then
    await expect(checkNativeGitServiceReadiness({
      tokenPath,
      origin: `http://127.0.0.1:${address.port}`
    })).resolves.toBeUndefined();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("fails a dripping response within the absolute two-second deadline without disclosing the token", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "dim-native-ready-timeout-"));
    roots.push(root);
    const tokenPath = join(root, "readiness.token");
    await writeFile(tokenPath, "private-native-ready-token\n");
    await chmod(tokenPath, 0o444);
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.write('{"status":"ready"');
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("test server address is unavailable");
    const started = performance.now();

    // When
    const action = checkNativeGitServiceReadiness({
      tokenPath,
      origin: `http://127.0.0.1:${address.port}`
    });

    // Then
    await expect(action).rejects.not.toThrow(/private-native-ready-token/);
    expect(performance.now() - started).toBeLessThan(2_500);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
