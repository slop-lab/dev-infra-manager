import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { NativeGitAdmissionHttpClient } from "../../../../core/packages/core/src/nativeGitAdmissionSource.js";
import {
  createNativeGitRootReadIssuerClient,
  createNodeNativeGitRootImporterClient,
  createNodeNativeGitRootReadIssuerClient,
  NativeGitRootReadIssuerClientError
} from "../../../../core/packages/core/src/index.js";
import { bundleSecrets } from "../../native-git/test/bundleConfigFixture.js";
import {
  activateFinalizeService,
  cleanupFinalizeFixtures,
  createFinalizeRoot,
  createRootBundle,
  generationId,
  importer,
  projectInput,
  rootReadIssuer,
  rootRepository,
  runGit,
  startFinalizeService
} from "../../native-git/test/nativeRootImportFinalizeFixture.js";

const run = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await cleanupFinalizeFixtures();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function connection(origin: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dim-root-read-issuer-client-"));
  roots.push(root);
  const path = join(root, "issuer.json");
  await writeFile(path, JSON.stringify({
    schemaVersion: 1, endpoint: origin, serviceId: "native-main",
    role: "operator-root-read-issuer", hostId: rootReadIssuer.hostId, generationId,
    credential: { username: rootReadIssuer.username, password: rootReadIssuer.password }
  }), { mode: 0o600 });
  return path;
}

describe("native Git root read issuer host client", () => {
  it("mints a Project-scoped lease that clones root while issuer-direct, foreign-Project, and push fail", async () => {
    const root = await createFinalizeRoot("issuer-client-service");
    const bundle = await createRootBundle();
    const bundlePath = join(await createFinalizeRoot("issuer-client-bundle"), "root.bundle");
    await writeFile(bundlePath, bundle.bytes);
    const service = await startFinalizeService(root);
    await activateFinalizeService(service.origin);
    await service.prepareProject(generationId, importer.hostId, projectInput("project-a"));
    const importerClient = await createNodeNativeGitRootImporterClient(await importerConnection(service.origin));
    await importerClient.importRoot({
      serviceId: "native-main", projectId: "project-a", rootRepositoryId: "root",
      protectedRef: "refs/heads/main", expectedCommit: bundle.commit,
      policy: { schemaVersion: 1, protectedRef: "refs/heads/main",
        policyRevision: "1260bff66b3d732abb336c2885d6a69a47e465369083c28875dc9cb09a9a480c",
        requiredReviewRevision: "02b474b992388d574069fe2806c9a918f3c660053df4ab6baf595d9d178ea824",
        requiredJobSetRevision: "b9763406fad20f0f816d6346d69d27eb953d7053301bd87275ba73b1f82bc8a1",
        requiredJobs: [{ name: "source", kind: "ordinary-sysbox", evidenceClass: "candidate-controlled" }],
        requiredReviewerIds: ["owner"], pathReviewerRules: [] },
      bundlePath
    }, AbortSignal.timeout(20_000));
    const client = await createNodeNativeGitRootReadIssuerClient(await connection(service.origin));

    const lease = await client.issueRootReadLease("project-a", AbortSignal.timeout(5_000));

    expect(lease).toMatchObject({ schemaVersion: 1, serviceId: "native-main", projectId: "project-a",
      rootRepositoryId: "root", generationId });
    expect(lease.expiresAt).toBeGreaterThan(Date.now());
    expect(lease.expiresAt).toBeLessThanOrEqual(Date.now() + 30_000);
    const clone = await createFinalizeRoot("issuer-client-clone");
    const repositoryUrl = `${service.origin}/v1/projects/project-a/repositories/root.git`;
    await runGitAuthenticated(["clone", repositoryUrl, clone], lease.username, lease.password);
    expect(await readFile(join(clone, "README.md"), "utf8")).toBe("root bundle\n");

    await expect(runGitAuthenticated(["ls-remote", repositoryUrl],
      rootReadIssuer.username, rootReadIssuer.password)).rejects.toThrow();
    await expect(runGitAuthenticated(["ls-remote",
      `${service.origin}/v1/projects/project-b/repositories/root.git`],
    lease.username, lease.password)).rejects.toThrow();

    await writeFile(join(clone, "change.txt"), "denied\n");
    await run("/usr/bin/git", ["-C", clone, "add", "change.txt"]);
    await run("/usr/bin/git", ["-C", clone, "-c", "user.name=DIM Test", "-c",
      "user.email=dim@example.invalid", "commit", "-m", "denied push"]);
    let pushFailure = "";
    try {
      await runGitAuthenticated(["-C", clone, "push", repositoryUrl,
        "HEAD:refs/heads/proposals/host/change"], lease.username, lease.password);
    } catch (error) {
      pushFailure = String(error);
    }
    expect(pushFailure).not.toBe("");
    expect(pushFailure).not.toContain(lease.username);
    expect(pushFailure).not.toContain(lease.password);
    expect((await runGit("/usr/bin/git", ["--git-dir", rootRepository(root),
      "for-each-ref", "--format=%(refname)"])).stdout).toBe("refs/heads/main\n");
  });

  it.each([
    ["wrong status", { statusCode: 200 }],
    ["cacheable", { cacheControl: "private" }],
    ["extra response field", { bodyChange: { extra: true } }],
    ["foreign Project", { bodyChange: { projectId: "project-b" } }],
    ["wrong root", { bodyChange: { rootRepositoryId: "other" } }],
    ["wrong generation", { bodyChange: { generationId: "b".repeat(64) } }],
    ["noncanonical username", { bodyChange: { username: "reader" } }],
    ["noncanonical password", { bodyChange: { password: "secret" } }],
    ["oversized body", { bodyChange: { username: `root-read-${"a".repeat(65 * 1024)}` } }],
    ["expired lease", { bodyChange: { expiresAt: Date.now() } }],
    ["overlong lease", { bodyChange: { expiresAt: Date.now() + 31_000 } }]
  ] as const)("rejects a %s lease response", async (_label, change) => {
    const responseBody = {
      schemaVersion: 1, serviceId: "native-main", projectId: "project-a", rootRepositoryId: "root",
      generationId, username: `root-read-${Buffer.alloc(18, 1).toString("base64url")}`,
      password: Buffer.alloc(32, 2).toString("base64url"), expiresAt: Date.now() + 25_000,
      ...("bodyChange" in change ? change.bodyChange : {})
    };
    const httpClient: NativeGitAdmissionHttpClient = {
      async request() {
        return { statusCode: "statusCode" in change ? change.statusCode : 201, contentType: "application/json",
          cacheControl: "cacheControl" in change ? change.cacheControl : "no-store",
          body: Buffer.from(JSON.stringify(responseBody)) };
      }
    };
    const client = createNativeGitRootReadIssuerClient(issuerConnection("http://127.0.0.1:1"), httpClient);

    await expect(client.issueRootReadLease("project-a", AbortSignal.timeout(5_000)))
      .rejects.toThrow(NativeGitRootReadIssuerClientError);
  });

  it("sends only the exact scoped request and redacts issuer credentials from failures", async () => {
    const requests: unknown[] = [];
    const secret = Buffer.alloc(32, 61).toString("base64url");
    const httpClient: NativeGitAdmissionHttpClient = {
      async request(input) {
        requests.push(input);
        throw new Error(`transport exposed ${secret}`);
      }
    };
    const client = createNativeGitRootReadIssuerClient({
      ...issuerConnection("http://127.0.0.1:1"), credential: { username: "issuer-a", password: secret }
    }, httpClient);

    let message = "";
    try {
      await client.issueRootReadLease("project-a", AbortSignal.timeout(5_000));
    } catch (error) {
      message = String(error);
    }

    expect(message).not.toContain(secret);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ method: "POST", path: "/v1/projects/project-a/root-read-leases",
      body: JSON.stringify({ schemaVersion: 1, generationId }) });
  });

  it("propagates caller cancellation through the bounded request", async () => {
    const controller = new AbortController();
    const httpClient: NativeGitAdmissionHttpClient = {
      request(input) {
        return new Promise((_resolve, reject) => {
          input.signal.addEventListener("abort", () => reject(input.signal.reason), { once: true });
        });
      }
    };
    const client = createNativeGitRootReadIssuerClient(issuerConnection("http://127.0.0.1:1"), httpClient);

    const pending = client.issueRootReadLease("project-a", controller.signal);
    controller.abort();

    await expect(pending).rejects.toThrow(NativeGitRootReadIssuerClientError);
  });
});

function issuerConnection(endpoint: string) {
  return {
    schemaVersion: 1, endpoint, serviceId: "native-main", role: "operator-root-read-issuer",
    hostId: rootReadIssuer.hostId, generationId,
    credential: { username: rootReadIssuer.username, password: rootReadIssuer.password }
  } as const;
}

async function importerConnection(origin: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dim-root-read-importer-client-"));
  roots.push(root);
  const path = join(root, "importer.json");
  await writeFile(path, JSON.stringify({
    schemaVersion: 1, endpoint: origin, serviceId: "native-main", role: "operator-root-importer",
    hostId: importer.hostId, generationId,
    credential: { username: importer.username, password: importer.password }
  }), { mode: 0o600 });
  return path;
}

async function runGitAuthenticated(
  arguments_: readonly string[],
  username: string,
  password: string
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  const authorization = `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
  return run("/usr/bin/git", [...arguments_], {
    env: { ...process.env, LANG: "C", GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: `Authorization: ${authorization}` }
  });
}
