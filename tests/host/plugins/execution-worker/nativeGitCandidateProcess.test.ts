import { mkdir, readdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { NativeOutputCollector } from "../../../../packages/host/plugins/execution-worker/src/output.js";
import { createServer, request as httpRequest, type Server } from "node:http";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { candidateFailureCode } from "../../../../packages/host/plugins/execution-worker/src/candidate-failure.js";
import { NativeGitProcessError, openDisposableGit } from "../../../../packages/host/plugins/execution-worker/src/nativeGitCandidateProcess.js";
import { gitHttpFixture } from "../../../support/gitHttpFixture.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

it.each(["success", "exit", "timeout"] as const)("reports authenticated Git duration/byte counts without private output (%s)", async mode => {
  const root = await mkdtemp(join(tmpdir(), "dim-git-timing-")), executable = join(root, "git-fixture");
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const diagnostic = "PRIVATE_URL_AND_PASSWORD";
  await writeFile(executable, `#!${process.execPath}\nif(process.argv[2]==='init')process.exit(0);process.stdout.write('data');process.stderr.write(${JSON.stringify(diagnostic)});${mode === "timeout" ? "setInterval(()=>{},1000);" : `process.exitCode=${mode === "exit" ? 23 : 0};`}\n`, { mode: 0o700 });
  const output = new NativeOutputCollector(8192, () => {}), git = await openDisposableGit({ executable, temporaryRoot: root,
    objectFormat: "sha1", username: "PRIVATE_USER", password: "PRIVATE_PASSWORD", timeoutMilliseconds: 1000, diagnostics: output.stderr }, new AbortController().signal);
  try {
    const pending = git.runAuthenticated(["fetch", "--depth=1", "PRIVATE_URL"], 64 * 1024, new AbortController().signal);
    if (mode === "success") {
      expect((await pending).toString()).toBe("data");
      // Local per-object inspections never emit one diagnostic per blob.
      await git.run(["cat-file", "PRIVATE_OBJECT"], 64 * 1024, new AbortController().signal);
    }
    else await expect(pending).rejects.toMatchObject({ name: "NativeGitProcessError", code: mode === "timeout" ? "timeout" : "failed" });
    const bytes = output.result().stderr.toString(), events = bytes.trim().split("\n").map(line => JSON.parse(line));
    expect(events).toHaveLength(4); // Credential + authenticated subprocess, never per-object lines.
    expect(events.at(-1)).toMatchObject({ phase: "candidate-fetch", event: "finish", status: mode === "success" ? "success" : "failure",
      stdoutBytes: 4, stderrBytes: Buffer.byteLength(diagnostic), exitCode: mode === "timeout" ? null : mode === "exit" ? 23 : 0,
      timeoutMilliseconds: 1000, elapsedMilliseconds: expect.any(Number) });
    if (mode === "timeout") { expect(events.at(-1).termination).toBe("timeout"); expect(events.at(-1).elapsedMilliseconds).toBeGreaterThanOrEqual(1000); }
    expect(bytes).not.toContain("PRIVATE");
  } finally { await git.close(); }
});

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
  const rejected = pending.catch((error: unknown) => error);
  // Attach the rejection handler before waiting for the stalled server.
  await requested;
  if (mode === "cancel") f.controller.abort();
  const error: unknown = await rejected;
  expect(error).toBeInstanceOf(NativeGitProcessError);
  expect(candidateFailureCode(error)).toBe(mode === "deadline" ? "candidate-read-timeout" : "candidate-read-aborted");
  await closed;
  await f.git.close();
  expect(await readdir(f.temporaryRoot)).toEqual([]);
});


it.each([
  [401, "candidate-read-auth-denied"],
  [403, "candidate-read-auth-denied"],
  [503, "candidate-read-transport-failed"],
  [404, "candidate-read-failed"]
] as const)("publishes a bounded diagnosis for real Git HTTP %i without retaining stderr", async (status, code) => {
  const f = await fixture();
  const endpoint = await listening(createServer((_request, response) => {
    response.writeHead(status, { "www-authenticate": 'Basic realm="private-realm"' }).end("private-response-body");
  }));
  const error: unknown = await f.git.runAuthenticated(["ls-remote", "--refs",
    `${endpoint}/private-repository-name.git`, "refs/heads/main"], 4096, f.controller.signal)
    .catch((failure: unknown) => failure);
  expect(error).toBeInstanceOf(NativeGitProcessError);
  expect(candidateFailureCode(error)).toBe(code);
  expect(error).toMatchObject({ message: "native Git operation failed" });
  const serialized = JSON.stringify(error);
  for (const secret of ["private-realm", "private-response-body", "private-repository-name", endpoint,
    "fixture-reader", "fixture-reader-password"]) expect(serialized).not.toContain(secret);
  expect(error).not.toHaveProperty("cause");
});

it("distinguishes a real Git transport disconnect from authentication denial", async () => {
  const f = await fixture();
  const endpoint = await listening(createServer((request) => { request.socket.destroy(); }));
  const error: unknown = await f.git.runAuthenticated(["ls-remote", "--refs",
    `${endpoint}/repo.git`, "refs/heads/main"], 4096, f.controller.signal).catch((failure: unknown) => failure);
  expect(candidateFailureCode(error)).toBe("candidate-read-transport-failed");
});

it("keeps Git output-limit failures distinct from network timeouts", async () => {
  const f = await fixture();
  const error: unknown = await f.git.run(["--version"], 1, f.controller.signal).catch((failure: unknown) => failure);
  expect(candidateFailureCode(error)).toBe("candidate-read-output-limit");
});
