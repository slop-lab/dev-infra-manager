import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { parseNativeOrdinaryBundleConfig } from "../../../../core/packages/core/src/nativeOrdinaryBundleConfig.js";
import { configuredNativeOrdinaryIdleServer } from "../../../../core/packages/core/src/nativeOrdinaryIdleService.js";
import { parseNativeGitBundleConfig } from "../../../../core/packages/native-git/src/bundle-config.js";
import { configuredNativeGitIdleServer } from "../../../../core/packages/native-git/src/native-idle-service.js";
import { createNodeAdmissionVerifierHttpClient } from "../../../../core/packages/native-git/src/ordinary-admission-http.js";
import { bundleSecrets, idleNativeConfig, idleOrdinaryConfig } from "./bundleConfigFixture.js";

const roots: string[] = [];
const servers: import("node:http").Server[] = [];
const ordinaryReadiness = Buffer.alloc(32, 31).toString("base64url");
const ordinaryActivation = Buffer.alloc(32, 32).toString("base64url");
const nativeReadiness = Buffer.alloc(32, 33).toString("base64url");
const nativeActivation = Buffer.alloc(32, 34).toString("base64url");
const rotatedNativeActivation = Buffer.alloc(32, 35).toString("base64url");
const generation = "a".repeat(64);
const nextGeneration = "b".repeat(64);

afterEach(async () => {
  await Promise.all(servers.splice(0).map(closeServer));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("native Git idle bundle service", () => {
  it("is ready only with the exact authenticated ordinary identity while ordinary readiness stays independent", async () => {
    // Given
    const ordinary = await startOrdinary();
    const native = await startNative(undefined, ordinary.origin);

    // When
    const [ordinaryReady, nativeReady] = await Promise.all([
      call(ordinary.port, "GET", "/readyz", ordinaryReadiness),
      call(native.port, "GET", "/readyz", nativeReadiness)
    ]);
    await closeServer(native.server);
    const ordinaryAfterNativeOutage = await call(ordinary.port, "GET", "/readyz", ordinaryReadiness);

    // Then
    expect(ordinaryReady.status).toBe(200);
    expect(nativeReady).toEqual({
      status: 200,
      body: { status: "ready", schemaVersion: 1 },
      contentType: "application/json",
      cacheControl: "no-store"
    });
    expect(ordinaryAfterNativeOutage.status).toBe(200);
  });

  it.each([
    ["peer outage", async () => "http://127.0.0.1:1"],
    ["wrong service ID", async () => startIdentityPeer({ serviceId: "ordinary-other" })],
    ["wrong scope", async () => startIdentityPeer({ scope: ["admission:read"] })],
    ["redirect", async () => startIdentityPeer({}, 302)]
  ])("returns 503 readiness for %s", async (_label, peerOrigin) => {
    // Given
    const native = await startNative(undefined, await peerOrigin());

    // When
    const result = await call(native.port, "GET", "/readyz", nativeReadiness);

    // Then
    expect(result.status).toBe(503);
    expect(JSON.stringify(result)).not.toContain(bundleSecrets.nativeQuery);
  });

  it("binds each activation generation to exactly one token while mutations remain unavailable", async () => {
    // Given
    const peer = await startIdentityPeer();
    const native = await startNative(undefined, peer);
    const mutationPaths = [
      "/v1/projects/project-a/repositories/root/reviews",
      "/v1/projects/project-a/repositories/root/promotions",
      "/project-a/root.git/git-receive-pack"
    ] as const;

    // When
    const before = await Promise.all(mutationPaths.map((path) => call(native.port, "POST", path, nativeActivation, {})));
    const beforeWrongGeneration = activationRows(native.root);
    const wrongGeneration = await activate(native.port, nextGeneration);
    const afterWrongGeneration = activationRows(native.root);
    const first = await activate(native.port, generation);
    const repeated = await activate(native.port, generation);
    const sameTokenDifferentGeneration = await activate(native.port, nextGeneration);
    await closeServer(native.server);
    const rotated = await startNative(native.root, peer, rotatedNativeActivation);
    const beforeConflict = activationRows(native.root);
    const sameGenerationDifferentToken = await activate(rotated.port, generation, rotatedNativeActivation);
    const afterConflict = activationRows(native.root);
    const forward = await activate(rotated.port, nextGeneration, rotatedNativeActivation);
    await closeServer(rotated.server);
    const rolledBack = await startNative(native.root, peer, nativeActivation);
    const rollback = await activate(rolledBack.port, generation);
    const after = await Promise.all(mutationPaths.map((path) => call(rolledBack.port, "POST", path, nativeActivation, {})));

    // Then
    expect(before.map((result) => result.status)).toEqual([503, 503, 503]);
    expect(wrongGeneration.status).toBe(409);
    expect(afterWrongGeneration).toEqual(beforeWrongGeneration);
    expect([first.status, repeated.status, forward.status, rollback.status]).toEqual([200, 200, 200, 200]);
    expect([sameTokenDifferentGeneration.status, sameGenerationDifferentToken.status]).toEqual([409, 409]);
    expect(afterConflict).toEqual(beforeConflict);
    expect(after.map((result) => result.status)).toEqual([503, 503, 503]);
    expect(activationRows(native.root)).toEqual([
      { generationId: generation, tokenSha256: tokenSha256(nativeActivation) },
      { generationId: nextGeneration, tokenSha256: tokenSha256(rotatedNativeActivation) }
    ]);
    expect(JSON.stringify([sameGenerationDifferentToken, sameTokenDifferentGeneration])).not.toContain(nativeActivation);
    expect(JSON.stringify([sameGenerationDifferentToken, sameTokenDifferentGeneration])).not.toContain(rotatedNativeActivation);
  });

  it("rejects cross-role credentials for readiness and activation", async () => {
    // Given
    const peer = await startIdentityPeer();
    const native = await startNative(undefined, peer);

    // When
    const ready = await call(native.port, "GET", "/readyz", nativeActivation);
    const activation = await call(native.port, "POST", "/v1/activation", nativeReadiness, {
      schemaVersion: 1,
      generationId: generation
    });

    // Then
    expect([ready.status, activation.status]).toEqual([404, 404]);
  });

  it("hides activation from a non-service-local peer before authorization and persistence", async () => {
    const peer = await startIdentityPeer();
    const native = await startNative(undefined, peer);

    const result = await call(native.port, "POST", "/v1/activation", nativeActivation, {
      schemaVersion: 1,
      generationId: generation
    }, "127.0.0.2");

    expect(result.status).toBe(404);
    expect(activationRows(native.root)).toEqual([]);
  });
});

async function startOrdinary(): Promise<{ readonly port: number; readonly origin: string }> {
  const root = await temporaryRoot();
  const server = await configuredNativeOrdinaryIdleServer({
    config: parseNativeOrdinaryBundleConfig(idleOrdinaryConfig()),
    stateDirectory: join(root, "ordinary"),
    readinessToken: ordinaryReadiness,
    activationToken: ordinaryActivation,
    expectedGenerationId: generation
  });
  const port = await listen(server);
  return { port, origin: `http://127.0.0.1:${port}` };
}

async function startNative(existingRoot: string | undefined, peerOrigin: string, activationToken = nativeActivation) {
  const root = existingRoot ?? await temporaryRoot();
  const server = await configuredNativeGitIdleServer({
    config: parseNativeGitBundleConfig(idleNativeConfig()),
    stateDirectory: join(root, "native"),
    readinessToken: nativeReadiness,
    activationToken,
    expectedGenerationId: activationToken === rotatedNativeActivation ? nextGeneration : generation,
    ordinaryIdentityHttpClient: createNodeAdmissionVerifierHttpClient(peerOrigin)
  });
  const port = await listen(server);
  return { root, server, port };
}

async function startIdentityPeer(overrides: Readonly<Record<string, unknown>> = {}, status = 200): Promise<string> {
  const server = (await import("node:http")).createServer((request_, response) => {
    response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", location: "/v1/identity" });
    response.end(JSON.stringify({
      schemaVersion: 1,
      serviceId: "ordinary-main",
      role: "native-query",
      scope: ["admission:read", "attempt:read"],
      ...overrides
    }));
  });
  return `http://127.0.0.1:${await listen(server)}`;
}

async function listen(server: import("node:http").Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new TypeError("test server has no TCP address");
  return address.port;
}

async function closeServer(server: import("node:http").Server): Promise<void> {
  const index = servers.indexOf(server);
  if (index >= 0) servers.splice(index, 1);
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
  server.closeAllConnections();
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dim-native-idle-http-"));
  roots.push(root);
  return root;
}

function activate(port: number, generationId: string, token = nativeActivation): Promise<HttpResult> {
  return call(port, "POST", "/v1/activation", token, { schemaVersion: 1, generationId });
}

function activationRows(root: string): readonly ActivationRow[] {
  const database = new DatabaseSync(join(root, "native", "native-idle.sqlite3"), { readOnly: true });
  const rows = database.prepare(
    "SELECT generation_id, activation_token_sha256 FROM bundle_activation ORDER BY generation_id"
  ).all().map((row) => ({
    generationId: Reflect.get(row, "generation_id"),
    tokenSha256: Reflect.get(row, "activation_token_sha256")
  }));
  database.close();
  return rows.filter((row): row is ActivationRow => typeof row.generationId === "string" && typeof row.tokenSha256 === "string");
}

function tokenSha256(token: string): string {
  return createHash("sha256").update(Buffer.from(token, "base64url")).digest("hex");
}

async function call(
  port: number,
  method: "GET" | "POST",
  path: string,
  token: string,
  body?: Readonly<Record<string, unknown>>,
  localAddress?: string
): Promise<HttpResult> {
  const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return new Promise((resolveCall, rejectCall) => {
    const outgoing = request({
      host: "127.0.0.1",
      localAddress,
      port,
      method,
      path,
      headers: {
        authorization: `Bearer ${token}`,
        ...(bytes === undefined ? {} : { "content-type": "application/json", "content-length": bytes.length })
      }
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolveCall({
          status: response.statusCode ?? 0,
          body: text === "" ? undefined : JSON.parse(text),
          contentType: response.headers["content-type"],
          cacheControl: response.headers["cache-control"]
        });
      });
    });
    outgoing.once("error", rejectCall);
    if (bytes !== undefined) outgoing.write(bytes);
    outgoing.end();
  });
}

type HttpResult = {
  readonly status: number;
  readonly body: unknown;
  readonly contentType: string | undefined;
  readonly cacheControl: string | undefined;
};

type ActivationRow = {
  readonly generationId: string;
  readonly tokenSha256: string;
};
