import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { createRepositoryService, GitRepositoryError, initializeRepository, repositoryRoute, serveGitBackend } from "../../../packages/gs/repository/src/index.js";

async function repositories() {
  const root = await mkdtemp(join(tmpdir(), "gs-backend-authority-"));
  const version = (await promisify(execFile)("/usr/bin/git", ["--version"])).stdout.trim().replace(/^git version /, "");
  const runtime = { storageRoot: root, gitExecutable: "/usr/bin/git", gitVersion: version };
  const first = { namespaceId: "first", repositoryId: "main" }, second = { namespaceId: "second", repositoryId: "main" };
  await initializeRepository(runtime, first); await initializeRepository(runtime, second);
  return { root, runtime, first, second };
}
async function listen(server: Server): Promise<string> {
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("missing fixture listener");
  return `http://127.0.0.1:${address.port}`;
}
async function close(server: Server): Promise<void> { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); }

it("rejects a forged backend path for another repository before executing Git", async () => {
  const f = await repositories();
  const server = createServer((request, response) => {
    void (async () => {
      const authorized = repositoryRoute(request);
      if (!authorized) { response.writeHead(404).end(); return; }
      await serveGitBackend({ config: f.runtime, request, response, identity: { role: "reader", username: "reader-first" },
        route: { ...authorized, pathInfo: "/second/main.git/info/refs" } });
    })().catch((error: unknown) => response.writeHead(error instanceof GitRepositoryError ? 400 : 500).end());
  });
  try {
    const origin = await listen(server);
    const response = await fetch(`${origin}/v1/namespaces/first/repositories/main.git/info/refs?service=git-upload-pack`);
    expect(response.status).toBe(400); await response.body?.cancel();
  } finally { await close(server); await rm(f.root, { recursive: true, force: true }); }
});

it("checks the current write grant after waiting for the repository queue", async () => {
  const f = await repositories(), firstSeen = Promise.withResolvers<void>(), releaseFirst = Promise.withResolvers<void>();
  const secondArrived = Promise.withResolvers<void>(); let secondAllowed = true;
  const server = await createRepositoryService({ runtime: f.runtime,
    repositories: [{ selector: f.first, protectedRefs: ["refs/heads/main"] }],
    async authorize({ request }) {
      if (request.headers.authorization === "first") { firstSeen.resolve(); await releaseFirst.promise; }
      else if (!secondAllowed) return undefined;
      return { selector: f.first, principalId: "writer", role: "writer" };
    }
  });
  server.on("request", (request) => { if (request.headers.authorization === "second") secondArrived.resolve(); });
  try {
    const origin = await listen(server), url = `${origin}/v1/namespaces/first/repositories/main.git/info/refs?service=git-receive-pack`;
    const first = fetch(url, { headers: { authorization: "first" } }); await firstSeen.promise;
    const second = fetch(url, { headers: { authorization: "second" } }); await secondArrived.promise;
    secondAllowed = false; releaseFirst.resolve();
    const [accepted, revoked] = await Promise.all([first, second]);
    expect(accepted.status).toBe(200); expect(revoked.status).toBe(401);
    await accepted.body?.cancel(); await revoked.body?.cancel();
  } finally { releaseFirst.resolve(); await close(server); await rm(f.root, { recursive: true, force: true }); }
});
