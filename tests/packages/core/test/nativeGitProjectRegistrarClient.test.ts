import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { NativeGitAdmissionHttpClient } from "../../../../core/packages/core/src/nativeGitAdmissionSource.js";
import {
  createNativeGitProjectRegistrarClient,
  createNodeNativeGitProjectRegistrarClient,
  NativeGitProjectRegistrarClientError
} from "../../../../core/packages/core/src/nativeGitProjectRegistrarClient.js";
import { parseNativeGitBundleConfig } from "../../../../core/packages/native-git/src/bundle-config.js";
import { configuredNativeGitBundleServer, type NativeGitBundleServer } from "../../../../core/packages/native-git/src/native-bundle-server.js";
import { idleNativeConfig } from "../../native-git/test/bundleConfigFixture.js";

const run = promisify(execFile);
const generationId = "a".repeat(64);
const registrarPassword = Buffer.alloc(32, 72).toString("base64url");
const unissuedPassword = Buffer.alloc(32, 73).toString("base64url");
const registrar = { hostId: "host-a", username: "project-registrar-a", password: registrarPassword } as const;
const roots: string[] = [];
const services: NativeGitBundleServer[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) =>
    server.close((error) => error === undefined ? resolve() : reject(error)))));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("native Git Project registrar client", () => {
  it("rejects a directly supplied non-loopback connection", () => {
    expect(() => createNativeGitProjectRegistrarClient({
      ...connection("http://127.0.0.1:1"), endpoint: "http://192.0.2.10:9080"
    }, { request: async () => { throw new Error("must not request"); } }))
      .toThrow("exact loopback HTTP origin");
  });

  it("prepares and replays a root without issuing Git authority before import", async () => {
    // Given
    const service = await startNativeGit();
    expect(await activate(service.origin)).toBe(200);
    const connectionPath = await writeConnection(service.origin, registrar);
    const client = await createNodeNativeGitProjectRegistrarClient(connectionPath);
    const preparation = projectPreparation();

    // When
    const first = await client.prepare(preparation, AbortSignal.timeout(5_000));
    const replay = await client.prepare(preparation, AbortSignal.timeout(5_000));
    const repository = `${service.origin}/v1/projects/project-a/repositories/root.git`;

    // Then
    expect(first).toEqual(replay);
    expect(first).toEqual({
      schemaVersion: 1, generationId, hostId: "host-a",
      preparation: {
        serviceId: "native-main", projectId: "project-a", rootRepositoryId: "root",
        state: "root-prepared"
      }
    });
    expect((await git(service.root, ["--git-dir", join(service.root, "project-a/root.git"), "for-each-ref", "--format=%(refname)"])).stdout).toBe("");
    await expect(git(service.root, ["ls-remote", repository])).rejects.toThrow();
    await expect(authenticatedGit(service.root, ["ls-remote", repository])).rejects.toThrow();
    expect(JSON.stringify(first)).not.toContain(unissuedPassword);
    expect(JSON.stringify(first)).not.toContain(registrarPassword);
  });

  it("attests immediately before every mutation and refuses foreign or invalid identities without POST", async () => {
    // Given
    const requests: string[] = [];
    const http: NativeGitAdmissionHttpClient = {
      async request(input) {
        requests.push(`${input.method} ${input.path}`);
        return {
          statusCode: 200, contentType: "application/json", cacheControl: "no-store", body: Buffer.from(JSON.stringify({
            schemaVersion: 1, serviceId: "native-main", role: "operator-project-registrar", hostId: "host-b"
          }))
        };
      }
    };
    const client = createNativeGitProjectRegistrarClient(connection("http://127.0.0.1:1"), http);

    // When / Then
    await expect(client.prepare(projectPreparation(), AbortSignal.timeout(5_000)))
      .rejects.toBeInstanceOf(NativeGitProjectRegistrarClientError);
    expect(requests).toEqual(["GET /v1/operator-project-registrar-identity"]);
  });

  it("leaves real service state unchanged on foreign host, wrong role, and wrong generation denials", async () => {
    // Given
    const service = await startNativeGit();
    expect(await activate(service.origin)).toBe(200);
    const databasePath = join(service.root, "native-idle.sqlite3");
    const before = await readFile(databasePath);
    const ordinaryQuery = idleNativeConfig().ordinaryCi.query;
    const foreign = await clientFor(service.origin, { hostId: "host-b" });
    const wrongRole = await clientFor(service.origin, { credential: ordinaryQuery });
    const wrongGeneration = await clientFor(service.origin, { generationId: "b".repeat(64) });

    // When
    const failures = await Promise.all([
      rejected(foreign), rejected(wrongRole), rejected(wrongGeneration)
    ]);

    // Then
    expect(failures.every((failure) => failure instanceof NativeGitProjectRegistrarClientError)).toBe(true);
    expect(failures.map(String).join("\n")).not.toContain(registrarPassword);
    expect(failures.map(String).join("\n")).not.toContain(unissuedPassword);
    expect(await readFile(databasePath)).toEqual(before);
  });

  it("rejects malformed identity and registration responses without disclosing credentials", async () => {
    // Given
    const origin = await malformedServer();
    const client = createNativeGitProjectRegistrarClient(connection(origin), {
      request: async (input) => {
        const response = await fetch(`${input.endpoint}${input.path}`, {
          method: input.method,
          headers: { authorization: input.authorization, accept: "application/json",
            ...(input.body === undefined ? {} : { "content-type": "application/json" }) },
          ...(input.body === undefined ? {} : { body: input.body }),
          signal: input.signal
        });
        return { statusCode: response.status, contentType: response.headers.get("content-type") ?? undefined,
          cacheControl: response.headers.get("cache-control") ?? undefined, body: Buffer.from(await response.arrayBuffer()) };
      }
    });

    // When
    const failure = await client.prepare(projectPreparation(), AbortSignal.timeout(5_000)).catch((error: unknown) => error);

    // Then
    expect(failure).toBeInstanceOf(NativeGitProjectRegistrarClientError);
    expect(String(failure)).not.toContain(registrarPassword);
    expect(String(failure)).not.toContain(unissuedPassword);
  });
});

async function startNativeGit() {
  const root = await temporaryRoot("dim-native-registrar-client-service-");
  const service = await configuredNativeGitBundleServer({
    config: parseNativeGitBundleConfig({ ...idleNativeConfig(), projectRegistrars: [registrar] }),
    stateDirectory: root,
    readinessToken: Buffer.alloc(32, 74).toString("base64url"),
    activationToken: Buffer.alloc(32, 75).toString("base64url"),
    expectedGenerationId: generationId
  });
  services.push(service);
  return { ...service, root, origin: await service.listen("127.0.0.1", 0) };
}

async function activate(origin: string): Promise<number> {
  return (await fetch(`${origin}/v1/activation`, { method: "POST", headers: {
    authorization: `Bearer ${Buffer.alloc(32, 75).toString("base64url")}`, "content-type": "application/json"
  }, body: JSON.stringify({ schemaVersion: 1, generationId }) })).status;
}

async function writeConnection(origin: string, credential: typeof registrar): Promise<string> {
  const path = join(await temporaryRoot("dim-native-registrar-client-connection-"), "connection.json");
  await writeFile(path, JSON.stringify(connection(origin, credential)), { mode: 0o600 });
  return path;
}

async function clientFor(
  origin: string,
  change: { readonly hostId?: string; readonly generationId?: string;
    readonly credential?: { readonly username: string; readonly password: string } }
) {
  const path = join(await temporaryRoot("dim-native-registrar-client-denial-"), "connection.json");
  await writeFile(path, JSON.stringify({ ...connection(origin), ...change }), { mode: 0o600 });
  return createNodeNativeGitProjectRegistrarClient(path);
}

async function rejected(client: Awaited<ReturnType<typeof clientFor>>): Promise<unknown> {
  return client.prepare(projectPreparation(), AbortSignal.timeout(5_000)).catch((error: unknown) => error);
}

function connection(origin: string, credential = registrar) {
  return { schemaVersion: 1, endpoint: origin, serviceId: "native-main", hostId: "host-a", generationId,
    credential: { username: credential.username, password: credential.password } } as const;
}

function projectPreparation() {
  return { serviceId: "native-main", projectId: "project-a", rootRepositoryId: "root" } as const;
}

async function malformedServer(): Promise<string> {
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(request.url?.includes("identity") ? "{}" : JSON.stringify({ accepted: true }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("test server did not bind TCP");
  return `http://127.0.0.1:${address.port}`;
}

function git(cwd: string, args: readonly string[]): Promise<{ readonly stdout: string; readonly stderr: string }> {
  return run("/usr/bin/git", args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" } });
}

async function authenticatedGit(
  cwd: string,
  args: readonly string[]
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  const helper = join(await temporaryRoot("dim-native-registrar-credential-helper-"), "credential-helper.sh");
  await writeFile(helper, "#!/bin/sh\nprintf 'username=%s\\npassword=%s\\n' \"$DIM_GIT_USERNAME\" \"$DIM_GIT_PASSWORD\"\n");
  await chmod(helper, 0o700);
  return run("/usr/bin/git", args, { cwd, env: {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: `!${helper}`,
    DIM_GIT_USERNAME: "writer-a",
    DIM_GIT_PASSWORD: unissuedPassword,
    LC_ALL: "C"
  } });
}

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}
