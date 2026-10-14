import { execFile, fork, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http, { type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { nativeTlsServer, type NativeTlsFixture } from "./nativeTlsFixture.js";

const run = promisify(execFile);
const script = join(import.meta.dirname, "../../../../core/images/project-workspace/agent-git-relay.mjs");

describe("recommended workspace Git relay transport", () => {
  const children: ChildProcess[] = [];
  const servers: http.Server[] = [];
  const tlsFixtures: NativeTlsFixture[] = [];
  const roots: string[] = [];

  afterEach(async () => {
    for (const child of children.splice(0)) child.kill("SIGTERM");
    await Promise.all(servers.splice(0).map(closeServer));
    await Promise.all(tlsFixtures.splice(0).map((fixture) => fixture.close()));
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("uses HTTPS with a valid CA and forwards only allowlisted headers", async () => {
    // Given
    const upstreamRequests: Array<{ readonly url: string; readonly headers: IncomingHttpHeaders }> = [];
    const tls = await nativeTlsServer((request, response) => {
      upstreamRequests.push({ url: request.url ?? "", headers: request.headers });
      response.writeHead(200, { "content-type": "application/x-git-upload-pack-result", "set-cookie": "blocked=1" });
      response.end("ok");
    });
    tlsFixtures.push(tls);
    const root = await mkdtemp(join(tmpdir(), "dim-agent-relay-"));
    roots.push(root);
    const caPath = join(root, "ca.pem");
    await writeFile(caPath, tls.ca);
    const relayPort = await reservePort();
    const child = fork(script, ["serve"], {
      silent: true,
      env: relayEnvironment(root, relayPort, tls.origin, {
        NODE_EXTRA_CA_CERTS: caPath,
        DIM_AGENT_GIT_INITIAL_PHASE: "setting-up"
      })
    });
    children.push(child);
    await ready(child);

    // When
    const result = await request(relayPort, "/project/root.git/info/refs?service=git-upload-pack", "GET", {
      authorization: "Bearer attacker",
      cookie: "session=attacker",
      forwarded: "for=attacker",
      "git-protocol": "version=2",
      "x-forwarded-for": "203.0.113.7"
    });

    // Then
    expect(result).toMatchObject({ status: 200, headers: { "content-type": "application/x-git-upload-pack-result" } });
    expect(result.headers["set-cookie"]).toBeUndefined();
    expect(upstreamRequests).toHaveLength(1);
    expect(upstreamRequests[0]).toEqual({
      url: "/project/root.git/info/refs?service=git-upload-pack",
      headers: expect.objectContaining({
        "git-protocol": "version=2",
        host: `localhost:${new URL(tls.origin).port}`
      })
    });
    expect(upstreamRequests[0]?.headers.authorization).toBeUndefined();
    expect(upstreamRequests[0]?.headers.cookie).toBeUndefined();
    expect(upstreamRequests[0]?.headers.forwarded).toBeUndefined();
    expect(upstreamRequests[0]?.headers["x-forwarded-for"]).toBeUndefined();
  });

  it("rejects redirects, absolute targets, and oversized requests", async () => {
    // Given
    const upstream = http.createServer((_request, response) => response.writeHead(302, { location: "http://example.invalid" }).end());
    servers.push(upstream);
    const upstreamPort = await listen(upstream);
    const root = await mkdtemp(join(tmpdir(), "dim-agent-relay-"));
    roots.push(root);
    const relayPort = await reservePort();
    const child = fork(script, ["serve"], {
      silent: true,
      env: relayEnvironment(root, relayPort, `http://127.0.0.1:${upstreamPort}`, {
        DIM_AGENT_GIT_INITIAL_PHASE: "ready"
      })
    });
    children.push(child);
    await ready(child);

    // When / Then
    await expect(request(relayPort, "/project/root.git/info/refs?service=git-upload-pack", "GET")).resolves.toMatchObject({ status: 502 });
    await expect(request(relayPort,
      `http://127.0.0.1:${upstreamPort}/project/root.git/info/refs?service=git-upload-pack`, "GET"))
      .resolves.toMatchObject({ status: 400 });
    await expect(request(relayPort, "/project/root.git/git-receive-pack", "POST", {
      "content-length": String(256 * 1024 * 1024 + 1),
      "content-type": "application/x-git-receive-pack-request"
    })).resolves.toMatchObject({ status: 413 });
  });

  it("allows checkout during setup and fences writes until ready", async () => {
    // Given
    const upstream = http.createServer((_request, response) => response.writeHead(200).end("ok"));
    servers.push(upstream);
    const upstreamPort = await listen(upstream);
    const root = await mkdtemp(join(tmpdir(), "dim-agent-relay-"));
    roots.push(root);
    const relayPort = await reservePort();
    const environment = relayEnvironment(root, relayPort, `http://127.0.0.1:${upstreamPort}`, {
      DIM_AGENT_GIT_INITIAL_PHASE: "setting-up"
    });
    const child = fork(script, ["serve"], { silent: true, env: environment });
    children.push(child);
    await ready(child);

    // When / Then
    await expect(request(relayPort, "/project/root.git/info/refs?service=git-upload-pack", "GET"))
      .resolves.toMatchObject({ status: 200 });
    await expect(request(relayPort, "/project/root.git/info/refs?service=git-receive-pack", "GET"))
      .resolves.toMatchObject({ status: 409 });
    await run(process.execPath, [script, "phase", "ready"], { env: environment });
    await expect(request(relayPort, "/project/root.git/info/refs?service=git-receive-pack", "GET"))
      .resolves.toMatchObject({ status: 200 });
    await run(process.execPath, [script, "phase", "setup-error"], { env: environment });
    await expect(request(relayPort, "/project/root.git/info/refs?service=git-upload-pack", "GET"))
      .resolves.toMatchObject({ status: 409 });
    await expect(request(relayPort, "/project/root.git/info/refs?service=git-receive-pack", "GET"))
      .resolves.toMatchObject({ status: 409 });
  });

  it("rejects the obsolete managed relay mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "dim-agent-relay-"));
    roots.push(root);
    const relayPort = await reservePort();
    const environment = {
      ...relayEnvironment(root, relayPort, "http://127.0.0.1:19418", {}),
      DIM_AGENT_GIT_RELAY_MODE: "managed",
      DIM_GIT_USERNAME: "writer",
      DIM_GIT_TOKEN: "secret"
    };

    await expect(run(process.execPath, [script, "serve"], { env: environment })).rejects.toMatchObject({
      stderr: expect.stringContaining("invalid agent Git relay configuration")
    });
  });
});

function relayEnvironment(root: string, port: number, upstream: string,
  extra: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...extra,
    DIM_AGENT_GIT_RELAY_MODE: "native",
    DIM_AGENT_GIT_UPSTREAM: upstream,
    DIM_AGENT_GIT_PATH: "/project/root.git",
    DIM_AGENT_GIT_LISTEN_HOST: "127.0.0.1",
    DIM_AGENT_GIT_LISTEN_PORT: String(port),
    DIM_AGENT_GIT_STATE_DIR: root
  };
}

async function ready(child: ChildProcess): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    child.once("message", () => resolve());
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`relay exited before readiness (${String(code)})`)));
  });
}

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("server has no TCP address");
  return address.port;
}

async function reservePort(): Promise<number> {
  const reservation = http.createServer();
  const port = await listen(reservation);
  await closeServer(reservation);
  return port;
}

async function closeServer(server: http.Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
}

async function request(port: number, path: string, method: "GET" | "POST",
  headers: Readonly<Record<string, string>> = {}): Promise<{ readonly status: number; readonly headers: IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const outgoing = http.request({ host: "127.0.0.1", port, path, method, headers }, (incoming) => {
      incoming.resume();
      incoming.once("end", () => resolve({ status: incoming.statusCode ?? 0, headers: incoming.headers }));
    });
    outgoing.once("error", reject);
    outgoing.end();
  });
}
