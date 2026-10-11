import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { parseNativeGitBundleConfig } from "../../../../core/packages/native-git/src/bundle-config.js";
import {
  configuredNativeGitBundleServer,
  type NativeGitBundleServer
} from "../../../../core/packages/native-git/src/native-bundle-server.js";
import type { NativeGitProjectRegistrar } from "../../../../core/packages/native-git/src/native-project-registrar-http.js";
import { idleNativeConfig } from "./bundleConfigFixture.js";
import { isExitError, refValue } from "./nativeGitHarness.js";

const run = promisify(execFile);
const generationId = "a".repeat(64);
const wrongGenerationId = "b".repeat(64);
const readinessToken = Buffer.alloc(32, 41).toString("base64url");
const activationToken = Buffer.alloc(32, 42).toString("base64url");
const rejectedWriter = {
  username: "writer-a",
  password: Buffer.alloc(32, 51).toString("base64url")
} as const;
const registrar = {
  hostId: "host-a",
  username: "project-registrar-a",
  password: Buffer.alloc(32, 43).toString("base64url")
} as const;
const registrarB = {
  hostId: "host-b",
  username: "project-registrar-b",
  password: Buffer.alloc(32, 44).toString("base64url")
} as const;
const projectA = { serviceId: "native-main", projectId: "project-a", rootRepositoryId: "root" } as const;
const roots: string[] = [];
const services: NativeGitBundleServer[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("operator Project registrar transport", () => {
  it("fails closed when no trusted registrar is configured", async () => {
    // Given
    const service = await start([]);
    expect(await activate(service.origin)).toBe(200);

    // When
    const identity = await request(service.origin, "GET", "/v1/operator-project-registrar-identity", registrar);
    const preparation = await prepare(service.origin, registrar, projectA);

    // Then
    expect([identity.status, preparation.status]).toEqual([404, 404]);
  });

  it("attests only the configured host-bound registrar role", async () => {
    // Given
    const service = await start([registrar]);
    const ordinaryQuery = idleNativeConfig().ordinaryCi.query;

    // When
    const identity = await request(service.origin, "GET", "/v1/operator-project-registrar-identity", registrar);
    const wrongRole = await request(service.origin, "GET", "/v1/operator-project-registrar-identity", ordinaryQuery);
    const unknown = await request(service.origin, "GET", "/v1/operator-project-registrar-identity", {
      username: "unknown", password: Buffer.alloc(32, 99).toString("base64url")
    });

    // Then
    expect(await identity.json()).toEqual({
      schemaVersion: 1, serviceId: "native-main", role: "operator-project-registrar", hostId: "host-a"
    });
    expect([identity.status, wrongRole.status, unknown.status]).toEqual([200, 403, 401]);
  });

  it("prepares an empty root without writer authority and replays exactly across restart", async () => {
    // Given
    const first = await start([registrar]);
    const databasePath = join(first.root, "native-idle.sqlite3");
    const beforeActivation = await readFile(databasePath);

    // When
    const inactive = await prepare(first.origin, registrar, projectA);

    // Then
    expect(inactive.status).toBe(503);
    expect(await readFile(databasePath)).toEqual(beforeActivation);

    // When
    expect(await activate(first.origin)).toBe(200);
    const prepared = await prepare(first.origin, registrar, projectA);

    // Then
    expect(prepared.status).toBe(200);
    expect(await prepared.json()).toEqual(preparationResponse(projectA));
    expect(await refValue(repository(first.root), "refs/heads/main")).toBeUndefined();
    expect(await refValue(repository(first.root), "refs/heads/proposals/workspace-a/change-1")).toBeUndefined();
    const database = new DatabaseSync(databasePath, { readOnly: true });
    expect(database.prepare("SELECT phase, owner_host_id FROM native_project_registration").get())
      .toEqual({ phase: "root-prepared", owner_host_id: "host-a" });
    expect(database.prepare("SELECT name FROM sqlite_schema WHERE name = 'native_project_writer'").get()).toBeUndefined();
    database.close();
    const beforeDenials = await readFile(databasePath);
    const oldCombined = await request(first.origin, "POST", "/v1/operator-project-registrations", registrar, {
      schemaVersion: 1,
      generationId,
      registration: { ...projectA, writer: { ...rejectedWriter, workspaceId: "workspace-a" } }
    });
    const wrongGeneration = await request(first.origin, "POST", "/v1/operator-project-preparations", registrar, {
      schemaVersion: 1, generationId: wrongGenerationId, preparation: projectA
    });
    await expect(git(first.root, ["ls-remote", writerUrl(first.origin)]))
      .rejects.toSatisfy((error: unknown) => isExitError(error) && /Authentication failed/.test(error.stderr));
    await expect(attemptPush(first.origin))
      .rejects.toSatisfy((error: unknown) => isExitError(error) && /Authentication failed/.test(error.stderr));
    expect([oldCombined.status, wrongGeneration.status]).toEqual([404, 409]);
    expect(await readFile(databasePath)).toEqual(beforeDenials);
    expect(await refValue(repository(first.root), "refs/heads/proposals/workspace-a/change-1")).toBeUndefined();

    // When
    await close(first);
    const restarted = await start([registrar], first.root);
    const beforeReplay = await readFile(databasePath);
    const replay = await prepare(restarted.origin, registrar, projectA);
    const replayBody: unknown = await replay.json();

    // Then
    expect(replay.status).toBe(200);
    expect(replayBody).toEqual(preparationResponse(projectA));
    expect(await readFile(databasePath)).toEqual(beforeReplay);
    expect(`${JSON.stringify(replayBody)}${await readFile(databasePath, "utf8")}`).not.toContain(registrar.password);
  });

  it("conceals an owned Project from another authenticated host without mutation", async () => {
    // Given
    const service = await start([registrar, registrarB]);
    expect(await activate(service.origin)).toBe(200);
    expect((await prepare(service.origin, registrar, projectA)).status).toBe(200);
    const databasePath = join(service.root, "native-idle.sqlite3");
    const before = await readFile(databasePath);

    // When
    const foreign = await prepare(service.origin, registrarB, projectA);

    // Then
    expect(foreign.status).toBe(404);
    expect(await readFile(databasePath)).toEqual(before);
  });
});

async function start(registrars: readonly NativeGitProjectRegistrar[], existingRoot?: string): Promise<RunningService> {
  const root = existingRoot ?? await mkdtemp(join(tmpdir(), "dim-native-registrar-"));
  if (existingRoot === undefined) roots.push(root);
  const service = await configuredNativeGitBundleServer({
    config: parseNativeGitBundleConfig({ ...idleNativeConfig(), projectRegistrars: registrars }), stateDirectory: root,
    readinessToken, activationToken, expectedGenerationId: generationId
  });
  services.push(service);
  return { ...service, root, origin: await service.listen("127.0.0.1", 0) };
}

async function close(service: NativeGitBundleServer): Promise<void> {
  const index = services.indexOf(service);
  if (index >= 0) services.splice(index, 1);
  await service.close();
}

async function activate(origin: string): Promise<number> {
  return (await fetch(`${origin}/v1/activation`, {
    method: "POST",
    headers: { authorization: `Bearer ${activationToken}`, "content-type": "application/json" },
    body: JSON.stringify({ schemaVersion: 1, generationId })
  })).status;
}

function prepare(
  origin: string,
  credential: NativeGitProjectRegistrar,
  preparation: typeof projectA
): Promise<Response> {
  return request(origin, "POST", "/v1/operator-project-preparations", credential, {
    schemaVersion: 1, generationId, preparation
  });
}

function request(
  origin: string,
  method: "GET" | "POST",
  path: string,
  credential: { readonly username: string; readonly password: string },
  body?: unknown
): Promise<Response> {
  return fetch(`${origin}${path}`, {
    method,
    headers: {
      authorization: `Basic ${Buffer.from(`${credential.username}:${credential.password}`, "utf8").toString("base64")}`,
      "content-type": "application/json"
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
}

function preparationResponse(preparation: typeof projectA) {
  return {
    schemaVersion: 1,
    generationId,
    hostId: registrar.hostId,
    preparation: { ...preparation, state: "root-prepared" }
  };
}

function repository(root: string): string {
  return join(root, projectA.projectId, "root.git");
}

function writerUrl(origin: string): string {
  return `${origin.replace("http://", `http://${rejectedWriter.username}:${rejectedWriter.password}@`)}`
    + `/v1/projects/${projectA.projectId}/repositories/root.git`;
}

function git(cwd: string, args: readonly string[]): Promise<{ readonly stdout: string; readonly stderr: string }> {
  return run("/usr/bin/git", args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" } });
}

async function attemptPush(origin: string): Promise<{ readonly stdout: string; readonly stderr: string }> {
  const root = await mkdtemp(join(tmpdir(), "dim-native-rejected-writer-"));
  roots.push(root);
  await git(root, ["init"]);
  await git(root, ["config", "user.name", "Rejected writer"]);
  await git(root, ["config", "user.email", "writer@example.invalid"]);
  await writeFile(join(root, "proposal.txt"), "proposal\n");
  await git(root, ["add", "proposal.txt"]);
  await git(root, ["commit", "-m", "proposal"]);
  return git(root, ["push", writerUrl(origin), "HEAD:refs/heads/proposals/workspace-a/change-1"]);
}

type RunningService = NativeGitBundleServer & { readonly root: string; readonly origin: string };
