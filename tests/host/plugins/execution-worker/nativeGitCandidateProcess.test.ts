import { mkdir, readdir } from "node:fs/promises";
import { createServer, request as httpRequest, type Server } from "node:http";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { openDisposableGit } from "../../../../packages/host/plugins/execution-worker/src/nativeGitCandidateProcess.js";
import { gitHttpFixture } from "../../../support/gitHttpFixture.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function listening(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing HTTP listener");
  return `http://127.0.0.1:${address.port}`;
}
async function fixture(timeoutMilliseconds = 30_000) {
  const native = await gitHttpFixture();
  cleanups.push(() => native.close());
  const temporaryRoot = join(native.root, "reader");
  await mkdir(temporaryRoot, { mode: 0o700 });
  const controller = new AbortController();
  const git = await openDisposableGit({ executable: "/usr/bin/git", temporaryRoot, objectFormat: "sha1",
    username: "fixture-reader", password: "fixture-reader-password", timeoutMilliseconds }, controller.signal);
  cleanups.push(async () => { controller.abort(); await git.close(); });
  return { native, git, controller, temporaryRoot };
}

it("accepts a real Git response delayed beyond ten seconds within the process deadline", { timeout: 30_000 }, async () => {
  const f = await fixture();
  let delayed = false;
  const proxy = createServer((request, response) => {
    const forward = () => {
      if (response.destroyed) return;
      const upstream = httpRequest(new URL(request.url ?? "/", f.native.baseUrl), {
        method: request.method, headers: request.headers
      }, (incoming) => { response.writeHead(incoming.statusCode ?? 502, incoming.headers); incoming.pipe(response); });
      upstream.once("error", () => { if (!response.destroyed) response.writeHead(502).end(); });
      response.once("close", () => upstream.destroy());
      request.pipe(upstream);
    };
    if (delayed) { forward(); return; }
    delayed = true;
    const timer = setTimeout(forward, 11_500);
    response.once("close", () => clearTimeout(timer));
  });
  const endpoint = await listening(proxy);
  const expected = (await f.native.git(f.native.root, ["--git-dir", f.native.repositoryPath("project-a", "source"),
    "rev-parse", "refs/heads/main"])).stdout.trim();
  const refs = await f.git.runAuthenticated(["ls-remote", "--refs",
    `${endpoint}/v1/projects/project-a/repositories/source.git`, "refs/heads/main"], 4096, f.controller.signal);
  expect(delayed).toBe(true);
  expect(refs.toString("utf8")).toBe(`${expected}\trefs/heads/main\n`);
});

it.each(["deadline", "cancel"] as const)("stops a stalled real Git request on %s and removes private reader state", async (mode) => {
  const f = await fixture(mode === "deadline" ? 1_000 : 30_000);
  let started!: () => void, disconnected!: () => void;
  const requested = new Promise<void>((resolve) => { started = resolve; });
  const closed = new Promise<void>((resolve) => { disconnected = resolve; });
  const server = createServer((_request, response) => { response.once("close", disconnected); started(); });
  const endpoint = await listening(server);
  const pending = f.git.runAuthenticated(["ls-remote", "--refs", `${endpoint}/repo.git`, "refs/heads/main"], 4096, f.controller.signal);
  const rejected = expect(pending).rejects.toThrow(mode === "deadline" ? "operation timed out" : "operation was aborted");
  await requested;
  if (mode === "cancel") f.controller.abort();
  await rejected;
  await closed;
  await f.git.close();
  expect(await readdir(f.temporaryRoot)).toEqual([]);
});
