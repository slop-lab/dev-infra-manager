import { dimWorkflowCompiler } from "@slop-lab/dim-control-plane-plugin-ci-workflows";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { parseManagedGitServiceConfig } from "@slop-lab/dim-control-plane-admin/service-pair";
import {
  activationTokenSha256,
  bindExactActivation
} from "../../../../packages/control-plane/plugins/git-repositories/src/native-bundle-activation.js";
import { initializeNativeGitBundleState } from "../../../../packages/control-plane/plugins/git-repositories/src/native-bundle-state.js";
import {
  configuredManagedGitFixture,
  type ManagedGitFixture,
  type ManagedGitFixtureOptions
} from "../../../support/managed-git-service.js";
import { beginNativeProjectPreparation } from "../../../../packages/control-plane/plugins/git-repositories/src/native-project-registry-state.js";
import { idleNativeConfig } from "./bundleConfigFixture.js";
import { isExitError, refValue } from "../../../support/gitHelpers.js";

const run = promisify(execFile);
const generationId = "a".repeat(64);
const wrongGenerationId = "b".repeat(64);
const readinessToken = Buffer.alloc(32, 41).toString("base64url");
const activationToken = Buffer.alloc(32, 42).toString("base64url");
const roots: string[] = [];
const services: ManagedGitFixture[] = [];

const projectA = preparation("project-a");
const projectB = preparation("project-b");
const rejectedWriter = {
  username: "writer-a",
  password: Buffer.alloc(32, 51).toString("base64url")
} as const;

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("activated native Git bundle transport", () => {
  it("returns bounded readiness without contacting ordinary CI", async () => {
    const root = await mkdtemp(join(tmpdir(), "dim-native-peer-readiness-"));
    roots.push(root);
    const service = await start(root, {
      async request(input) {
        expect([input.endpoint, input.method, input.path]).toEqual([
          "http://ordinary-ci:8080", "GET", "/v1/native-root-admission/identity"
        ]);
        return {
          statusCode: 200,
          contentType: "application/json",
          cacheControl: "no-store",
          body: Buffer.alloc(0)
        };
      }
    });

    const response = await fetch(`${service.origin}/readyz`, {
      headers: { authorization: `Bearer ${readinessToken}` }
    });

    expect(response.status).toBe(200);
  });

  it("returns unavailable readiness when the ordinary CI identity cannot be attested", async () => {
    const root = await mkdtemp(join(tmpdir(), "dim-native-readiness-"));
    roots.push(root);
    const service = await start(root);

    const response = await fetch(`${service.origin}/readyz`, {
      headers: { authorization: `Bearer ${readinessToken}` }
    });

    expect(response.status).toBe(200);
  });

  it("prepares roots only after exact activation without exposing Git authority", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "dim-native-bundle-transport-"));
    roots.push(root);
    const first = await start(root);
    const beforeActivation = first.prepareProject(generationId, "host-a", projectA);

    // When
    const wrongActivation = await activate(first.origin, wrongGenerationId);

    // Then
    await expect(beforeActivation).rejects.toThrow(/activation/i);
    expect(wrongActivation).toBe(409);
    await expect(first.prepareProject(wrongGenerationId, "host-a", projectA)).rejects.toThrow(/activation/i);

    // When
    expect(await activate(first.origin, generationId)).toBe(200);
    const database = new DatabaseSync(join(root, "native-idle.sqlite3"));
    database.prepare("INSERT INTO bundle_activation (generation_id, activation_token_sha256) VALUES (?, ?)")
      .run(wrongGenerationId, "c".repeat(64));
    database.close();
    const beforeWrongGeneration = await readFile(join(root, "native-idle.sqlite3"));
    await expect(first.prepareProject(wrongGenerationId, "host-a", projectA)).rejects.toThrow(/activation/i);
    expect(await readFile(join(root, "native-idle.sqlite3"))).toEqual(beforeWrongGeneration);
    const registeredA = await first.prepareProject(generationId, "host-a", projectA);
    const registeredB = await first.prepareProject(generationId, "host-a", projectB);
    const beforeReplay = await readFile(join(root, "native-idle.sqlite3"));
    const replayA = await first.prepareProject(generationId, "host-a", projectA);

    // Then
    expect([registeredA, replayA]).toEqual([
      { serviceId: "native-main", projectId: "project-a", repositoryId: "root", state: "repository-prepared" },
      { serviceId: "native-main", projectId: "project-a", repositoryId: "root", state: "repository-prepared" }
    ]);
    expect(await readFile(join(root, "native-idle.sqlite3"))).toEqual(beforeReplay);
    expect(registeredB.projectId).toBe("project-b");
    await expect(first.prepareProject(generationId, "host-a", { ...projectA, repositoryId: "../other" }))
      .rejects.toThrow(/invalid/i);
    await expect(start(root)).rejects.toThrow(/active server/i);
    const databaseBytes = await readFile(join(root, "native-idle.sqlite3"));
    expect(databaseBytes.includes(Buffer.from(rejectedWriter.password))).toBe(false);
    const publicRegistration = await fetch(`${first.origin}/v1/projects/project-c/registrations`, {
      method: "POST",
      headers: { authorization: `Bearer ${activationToken}`, "content-type": "application/json" },
      body: JSON.stringify(projectA)
    });
    const activationCredentialTransport = await fetch(
      `${first.origin}/v1/projects/project-a/repositories/root.git/info/refs?service=git-upload-pack`,
      { headers: { authorization: `Basic ${Buffer.from(`${activationToken}:${activationToken}`).toString("base64")}` } }
    );
    expect([publicRegistration.status, activationCredentialTransport.status]).toEqual([404, 401]);

    // When
    const beforeGit = await readFile(join(root, "native-idle.sqlite3"));
    const transport = git(root, ["ls-remote", url(first.origin, "project-a")]);

    // Then
    await expect(transport)
      .rejects.toSatisfy((error: unknown) => isExitError(error) && /Authentication failed/.test(error.stderr));
    expect(await readFile(join(root, "native-idle.sqlite3"))).toEqual(beforeGit);
    expect(await refValue(repository(root, "project-a"), "refs/heads/main")).toBeUndefined();

    // When
    await close(first);
    const restarted = await start(root);

    // Then
    await expect(git(root, ["ls-remote", url(restarted.origin, "project-a")]))
      .rejects.toSatisfy((error: unknown) => isExitError(error) && /Authentication failed/.test(error.stderr));
  });

  it("recovers pending Project storage without issuing a workspace writer", async () => {
    // Given
    const root = await pendingRegistration(projectA);

    // When
    const recovered = await start(root);

    // Then
    const database = new DatabaseSync(join(root, "native-idle.sqlite3"), { readOnly: true });
    expect(database.prepare("SELECT phase FROM native_repository_registration WHERE project_id = ? AND repository_id = ?")
      .get(projectA.projectId, projectA.repositoryId)).toEqual({ phase: "repository-prepared" });
    expect(database.prepare("SELECT name FROM sqlite_schema WHERE name = 'native_project_writer'").get()).toBeUndefined();
    database.close();
    await expect(git(root, ["ls-remote", url(recovered.origin, "project-a")]))
      .rejects.toSatisfy((error: unknown) => isExitError(error) && /Authentication failed/.test(error.stderr));
    expect((await readFile(join(root, "project-a", ".dim-native-project-owner"), "utf8")))
      .toContain(projectA.projectId);

    const replay = await recovered.prepareProject(generationId, "host-a", projectA);
    expect(replay.state).toBe("repository-prepared");
    await expect(git(root, ["ls-remote", url(recovered.origin, "project-a")]))
      .rejects.toSatisfy((error: unknown) => isExitError(error) && /Authentication failed/.test(error.stderr));
  });

  it("refuses same-name storage instead of adopting it for a pending Project", async () => {
    // Given
    const root = await pendingRegistration(projectA);
    await mkdir(join(root, "project-a"), { mode: 0o700 });
    const before = await readFile(join(root, "native-idle.sqlite3"));

    // When
    const restart = start(root);

    // Then
    await expect(restart).rejects.toThrow(/owner marker|ownership/i);
    expect(await readFile(join(root, "native-idle.sqlite3"))).toEqual(before);
  });

  it("refuses trusted registration after shutdown releases storage ownership", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "dim-native-closed-"));
    roots.push(root);
    const service = await start(root);
    expect(await activate(service.origin, generationId)).toBe(200);
    await close(service);

    // When
    const registration = service.prepareProject(generationId, "host-a", projectA);

    // Then
    await expect(registration).rejects.toThrow(/closed/i);
  });
});

async function pendingRegistration(input: Registration): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dim-native-pending-"));
  roots.push(root);
  const state = await initializeNativeGitBundleState(root);
  bindExactActivation(state, generationId, activationTokenSha256(activationToken));
  beginNativeProjectPreparation(state.database, generationId, {
    serviceId: input.serviceId,
    projectId: input.projectId,
    repositoryId: input.repositoryId,
    ownerHostId: "host-a"
  });
  await state.owner.release();
  return root;
}

async function start(
  root: string,
  ordinaryIdentityHttpClient?: ManagedGitFixtureOptions["ordinaryIdentityHttpClient"]
): Promise<RunningService> {
  const service = await configuredManagedGitFixture({ workflowCompiler: dimWorkflowCompiler,
    config: parseManagedGitServiceConfig(idleNativeConfig()),
    stateDirectory: root,
    readinessToken,
    activationToken,
    expectedGenerationId: generationId,
    ...(ordinaryIdentityHttpClient === undefined ? {} : { ordinaryIdentityHttpClient })
  });
  services.push(service);
  const origin = await service.listen("127.0.0.1", 0);
  return { ...service, origin };
}

async function close(service: ManagedGitFixture): Promise<void> {
  const index = services.indexOf(service);
  if (index >= 0) services.splice(index, 1);
  await service.close();
}

async function activate(origin: string, requestedGenerationId: string): Promise<number> {
  const response = await fetch(`${origin}/v1/activation`, {
    method: "POST",
    headers: { authorization: `Bearer ${activationToken}`, "content-type": "application/json" },
    body: JSON.stringify({ schemaVersion: 1, generationId: requestedGenerationId })
  });
  return response.status;
}

function git(cwd: string, args: readonly string[]): Promise<{ readonly stdout: string; readonly stderr: string }> {
  return run("/usr/bin/git", args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" } });
}

function url(origin: string, projectId: string): string {
  const authenticated = origin.replace("http://", `http://${rejectedWriter.username}:${rejectedWriter.password}@`);
  return `${authenticated}/v1/projects/${projectId}/repositories/root.git`;
}

function repository(root: string, projectId: string): string {
  return join(root, projectId, "root.git");
}

function preparation(projectId: string) {
  return {
    serviceId: "native-main",
    projectId,
    repositoryId: "root"
  } as const;
}

type Registration = ReturnType<typeof preparation>;
type RunningService = ManagedGitFixture & { readonly origin: string };
