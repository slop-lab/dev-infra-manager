import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { createReviewerWebServerFromConfigFile, type ReviewerWebServer } from "../../../../core/packages/web/src/index.js";
import { readJsonObject, stringField } from "../../native-git/test/nativeGitReviewHarness.js";
import { WEB_PASSWORD, WEB_USERNAME, webConfig } from "./webHarness.js";

const roots: string[] = [];
const services: ReviewerWebServer[] = [];
const nativeServers: Server[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
  await Promise.all(nativeServers.splice(0).map(async (server) => {
    server.close();
    await once(server, "close");
  }));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("DIM reviewer web browser-boundary rejection", () => {
  it("rejects wrong authentication, Origin, CSRF, and Project before a native review request", async () => {
    // Given
    let nativeReviewRequests = 0;
    const native = createServer((request, response) => {
      if (request.url === "/v1/identity") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(`${JSON.stringify({ role: "reviewer", projectId: "project-a", repositoryIds: ["source"], reviewerId: "reviewer-a" })}\n`);
        return;
      }
      nativeReviewRequests += 1;
      response.writeHead(503).end();
    });
    native.listen(0, "127.0.0.1");
    await once(native, "listening");
    nativeServers.push(native);
    const address = native.address();
    if (address === null || typeof address === "string") throw new Error("expected native TCP address");
    const origin = "http://127.0.0.1:40104";
    const root = await mkdtemp(join(tmpdir(), "dim-reviewer-rejection-"));
    roots.push(root);
    const configPath = join(root, "config.json");
    await writeFile(configPath, JSON.stringify(webConfig({ nativeBaseUrl: `http://127.0.0.1:${address.port}`, publicOrigin: origin, port: 0 })), { mode: 0o600 });
    await chmod(configPath, 0o600);
    const service = await createReviewerWebServerFromConfigFile(configPath);
    services.push(service);
    const baseUrl = await service.listen();
    const login = await fetch(`${baseUrl}/v1/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ username: WEB_USERNAME, password: WEB_PASSWORD })
    });
    const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
    const csrfToken = stringField(await readJsonObject(login), "csrfToken");
    if (cookie === undefined) throw new Error("expected session cookie");
    const collection = `${baseUrl}/v1/projects/project-a/repositories/source/reviews`;
    const body = JSON.stringify({ protectedRef: "refs/heads/main", proposalRef: "refs/heads/proposals/workspace-a/change-1" });

    // When
    const responses = await Promise.all([
      fetch(`${baseUrl}/v1/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: origin },
        body: JSON.stringify({ username: WEB_USERNAME, password: "wrong-password" })
      }),
      fetch(collection, { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json", Origin: "http://127.0.0.1:1", "X-DIM-CSRF": csrfToken }, body }),
      fetch(collection, { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json", Origin: origin, "X-DIM-CSRF": "wrong-token" }, body }),
      fetch(collection, { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json", Origin: origin, "X-DIM-CSRF": csrfToken }, body: JSON.stringify({ protectedRef: "refs/heads/main\nforged", proposalRef: "refs/heads/proposals/workspace-a/change-1" }) }),
      fetch(`${baseUrl}/v1/projects/project-b/repositories/source/reviews/${"a".repeat(64)}`, { headers: { Cookie: cookie } })
    ]);

    // Then
    expect(responses.map((response) => response.status)).toEqual([401, 403, 403, 400, 404]);
    expect(nativeReviewRequests).toBe(0);
    const serialized = (await Promise.all(responses.map((response) => response.text()))).join("\n");
    expect(serialized).not.toContain("reviewer-a-user");
    expect(serialized).not.toContain("reviewer-a-secret");
    expect(serialized).not.toContain(WEB_PASSWORD);
  });
});
