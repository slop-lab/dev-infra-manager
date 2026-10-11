import { execFile } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { startGitSmartHttp, type GitSmartHttp } from "./gitSmartHttp.js";

const execute = promisify(execFile);
const serviceScript = join(
  import.meta.dirname,
  "../../../../core/packages/core/src/shared-git-sync-assets/server.py"
);

type Fixture = {
  readonly endpoint: string;
  readonly external: string;
  readonly managed: string;
  readonly managedHttp?: GitSmartHttp;
  readonly process: import("node:child_process").ChildProcess;
  readonly root: string;
  readonly work: string;
};

const fixtures: Fixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(async (fixture) => {
    fixture.process.kill("SIGTERM");
    if (fixture.process.exitCode === null) await once(fixture.process, "exit");
    if (fixture.managedHttp !== undefined) await fixture.managedHttp.close();
    await rm(fixture.root, { recursive: true, force: true });
  }));
});

describe("shared Git-host synchronization service", () => {
  it("reuses one actual bare repository and persists a credential-free upstream remote", async () => {
    // Given
    const fixture = await startFixture();
    await git(["--git-dir", fixture.managed, "config", "--add", "uploadpack.hideRefs", "refs/private/"]);
    await commitAndPush(fixture, "first");

    // When
    expect((await fetchRepository(fixture)).status).toBe(204);
    await commitAndPush(fixture, "second");
    expect((await fetchRepository(fixture)).status).toBe(204);

    // Then
    const externalHead = await git(["--git-dir", fixture.external, "rev-parse", "refs/heads/main"]);
    const trackedHead = await git(["--git-dir", fixture.managed, "rev-parse", "refs/heads/upstream/main"]);
    expect(trackedHead).toBe(externalHead);
    expect(await git(["--git-dir", fixture.managed, "config", "remote.dim-upstream.url"]))
      .toBe(fixture.external);
    expect(await readFile(join(fixture.managed, "config"), "utf8")).not.toContain("service-secret");
    expect((await git(["--git-dir", fixture.managed, "config", "--get-all", "uploadpack.hideRefs"])).split("\n"))
      .toEqual(["refs/private/", "refs/dim-sync/"]);
    expect(await git(["--git-dir", fixture.managed, "for-each-ref", "--format=%(refname)", "refs/dim-sync"]))
      .toBe("");
  });

  it("publishes only configured branches without forcing divergent history", async () => {
    // Given
    const fixture = await startFixture();
    await commitAndPush(fixture, "external-base");
    expect((await fetchRepository(fixture)).status).toBe(204);
    await git(["--git-dir", fixture.managed, "update-ref", "refs/heads/main", await git([
      "--git-dir", fixture.managed, "rev-parse", "refs/heads/upstream/main"
    ])]);
    await commitAndPushManaged(fixture, "managed-change");
    await git(["--git-dir", fixture.managed, "update-ref", "refs/dim-sync/stale", await git([
      "--git-dir", fixture.managed, "rev-parse", "refs/heads/main"
    ])]);

    // When
    const published = await publishRepository(fixture, { main: "main" });

    // Then
    expect(published.status).toBe(204);
    expect(await git(["--git-dir", fixture.managed, "for-each-ref", "--format=%(refname)", "refs/dim-sync"]))
      .toBe("");
    expect(await git(["--git-dir", fixture.external, "rev-parse", "refs/heads/main"]))
      .toBe(await git(["--git-dir", fixture.managed, "rev-parse", "refs/heads/main"]));
    await commitExternalDivergence(fixture, "external-divergence");
    await commitAndPushManaged(fixture, "managed-divergence");
    await git(["--git-dir", fixture.managed, "update-ref", "refs/dim-sync/stale", await git([
      "--git-dir", fixture.managed, "rev-parse", "refs/heads/main"
    ])]);
    expect((await publishRepository(fixture, { main: "main" })).status).toBe(409);
    expect(await git(["--git-dir", fixture.managed, "for-each-ref", "--format=%(refname)", "refs/dim-sync"]))
      .toBe("");
  });

  it("rejects unregistered aliases and disallowed local upstream paths", async () => {
    // Given
    const fixture = await startFixture();
    const outside = await mkdtemp(join(tmpdir(), "dim-git-sync-outside-"));

    // When
    const unknown = await request(fixture, "/v1/repositories/shared-project/missing/fetch", fetchBody(fixture));
    const disallowed = await request(fixture, "/v1/repositories/shared-project/root/fetch", {
      ...fetchBody(fixture),
      externalUrl: outside
    });
    const unsafeNamespace = await request(fixture, "/v1/repositories/shared-project/root/fetch", {
      ...fetchBody(fixture),
      refNamespace: { prefix: "../" }
    });
    const malformedUrl = await request(fixture, "/v1/repositories/shared-project/root/fetch", {
      ...fetchBody(fixture),
      externalUrl: "https://[invalid"
    });

    // Then
    expect(unknown.status).toBe(404);
    expect(disallowed.status).toBe(400);
    expect(unsafeNamespace.status).toBe(400);
    expect(malformedUrl.status).toBe(400);
    await rm(outside, { recursive: true, force: true });
  });

  it("rejects invalid transport hosts instead of silently removing them", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "dim-git-sync-invalid-config-"));
    fixtures.push({ endpoint: "", external: "", managed: "", process: execFile("true"), root, work: "" });
    const repositories = join(root, "repositories");
    await git(["init", "--bare", join(repositories, "root.git")]);
    const config = join(root, "config.json");
    await writeFile(config, JSON.stringify({
      schemaVersion: 1,
      listen: { host: "127.0.0.1", port: 8080 },
      repositoriesRoot: repositories,
      stateRoot: join(root, "state"),
      apiToken: "service-secret",
      timeoutSeconds: 30,
      transportPolicy: { httpsHosts: ["bad host"], httpHosts: [], sshHosts: [], localRoots: [] },
      repositories: {
        "shared-project/root": {
          relativePath: "root.git",
          managedUrl: join(repositories, "root.git")
        }
      }
    }), { mode: 0o600 });
    await chmod(config, 0o600);

    // When / Then
    await expect(execute("python3", [serviceScript, config])).rejects.toMatchObject({ code: 1 });
  });
});

async function startFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "dim-git-sync-test-"));
  const repositories = join(root, "repositories");
  const managed = join(repositories, "dim-acme", "root.git");
  const external = join(root, "upstreams", "root.git");
  const work = join(root, "work");
  await git(["init", "--bare", managed]);
  await git(["--git-dir", managed, "config", "http.receivepack", "true"]);
  const managedHttp = await startGitSmartHttp(repositories);
  await git(["init", "--bare", external]);
  await git(["clone", external, work]);
  await git(["-C", work, "config", "user.name", "Test User"]);
  await git(["-C", work, "config", "user.email", "test@example.invalid"]);
  const port = await availablePort();
  const config = join(root, "config.json");
  await writeFile(config, JSON.stringify({
    schemaVersion: 1,
    listen: { host: "127.0.0.1", port },
    repositoriesRoot: repositories,
    stateRoot: join(root, "state"),
    apiToken: "service-secret",
    timeoutSeconds: 30,
    transportPolicy: { httpsHosts: [], httpHosts: [], sshHosts: [], localRoots: [join(root, "upstreams")] },
    repositories: {
      "shared-project/root": {
        relativePath: "dim-acme/root.git",
        managedUrl: `${managedHttp.baseUrl}/dim-acme/root.git`
      }
    }
  }), { mode: 0o600 });
  await chmod(config, 0o600);
  const child = execFile("python3", [serviceScript, config]);
  const fixture = { endpoint: `http://127.0.0.1:${port}`, external, managed, managedHttp, process: child, root, work };
  fixtures.push(fixture);
  await waitFor(async () => (await fetch(`${fixture.endpoint}/healthz`)).status === 200);
  return fixture;
}

async function commitAndPush(fixture: Fixture, content: string): Promise<void> {
  await writeFile(join(fixture.work, "content.txt"), content);
  await git(["-C", fixture.work, "add", "content.txt"]);
  await git(["-C", fixture.work, "commit", "-m", content]);
  await git(["-C", fixture.work, "push", "origin", "HEAD:refs/heads/main"]);
}

async function commitAndPushManaged(fixture: Fixture, content: string): Promise<void> {
  const work = join(fixture.root, `managed-work-${content}`);
  await git(["clone", fixture.managed, work]);
  await git(["-C", work, "config", "user.name", "Test User"]);
  await git(["-C", work, "config", "user.email", "test@example.invalid"]);
  await git(["-C", work, "checkout", "main"]);
  await writeFile(join(work, "managed.txt"), content);
  await git(["-C", work, "add", "managed.txt"]);
  await git(["-C", work, "commit", "-m", content]);
  await git(["-C", work, "push", "origin", "main"]);
}

async function commitExternalDivergence(fixture: Fixture, content: string): Promise<void> {
  const work = join(fixture.root, "external-divergence");
  await git(["clone", fixture.external, work]);
  await git(["-C", work, "config", "user.name", "Test User"]);
  await git(["-C", work, "config", "user.email", "test@example.invalid"]);
  await git(["-C", work, "checkout", "main"]);
  await writeFile(join(work, "external.txt"), content);
  await git(["-C", work, "add", "external.txt"]);
  await git(["-C", work, "commit", "-m", content]);
  await git(["-C", work, "push", "origin", "main"]);
}

function fetchBody(fixture: Fixture): Readonly<Record<string, unknown>> {
  return {
    externalUrl: fixture.external,
    refNamespace: null,
    prune: false,
    externalCredential: null,
    managedCredential: null
  };
}

function fetchRepository(fixture: Fixture): Promise<Response> {
  return request(fixture, "/v1/repositories/shared-project/root/fetch", fetchBody(fixture));
}

function publishRepository(fixture: Fixture, publishBranches: Readonly<Record<string, string>>): Promise<Response> {
  return request(fixture, "/v1/repositories/shared-project/root/publish", {
    externalUrl: fixture.external,
    refNamespace: null,
    publishBranches,
    externalCredential: null
  });
}

function request(fixture: Fixture, pathname: string, body: Readonly<Record<string, unknown>>): Promise<Response> {
  return fetch(`${fixture.endpoint}${pathname}`, {
    method: "POST",
    headers: { Authorization: "Bearer service-secret", "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

async function git(args: readonly string[]): Promise<string> {
  const result = await execute("git", [...args], { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  return result.stdout.trim();
}

async function availablePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("expected TCP listener");
  server.close();
  await once(server, "close");
  return address.port;
}

async function waitFor(check: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await check().catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("service did not become ready");
}
