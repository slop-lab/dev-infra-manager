import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { NativeGitAdmissionHttpClient } from "../../../../core/packages/core/src/nativeGitAdmissionSource.js";
import {
  createNativeGitWorkspaceWriteIssuerClient,
  createNodeNativeGitWorkspaceWriteIssuerClient,
  NativeGitWorkspaceWriteIssuerClientError
} from "../../../../core/packages/core/src/index.js";
import {
  activateFinalizeService,
  cleanupFinalizeFixtures,
  createFinalizeRoot,
  createRootBundle,
  finalizeRootImport,
  generationId,
  importer,
  parseImportReceipt,
  projectInput,
  rootReadIssuerAuthorization,
  startFinalizeService,
  uploadRootBundle,
  workspaceWriteIssuer
} from "../../native-git/test/nativeRootImportFinalizeFixture.js";

const roots: string[] = [];
const workspaceId = Buffer.alloc(32, 60).toString("base64url");

afterEach(async () => {
  await cleanupFinalizeFixtures();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("native Git workspace write issuer host client", () => {
  it("loads a private connection and mints one exact Project/root/workspace-scoped lease", async () => {
    // Given
    const origin = await finalizedService("workspace-write-client-service");
    const client = await createNodeNativeGitWorkspaceWriteIssuerClient(await connection(origin));

    // When
    const lease = await client.issueWorkspaceWriteLease({
      projectId: "project-a", repositoryId: "root", workspaceId
    }, AbortSignal.timeout(5_000));

    // Then
    expect(lease).toMatchObject({
      schemaVersion: 1, serviceId: "native-main", projectId: "project-a", repositoryId: "root",
      generationId, workspaceId
    });
    expect(lease.username).toMatch(/^workspace-write-[A-Za-z0-9_-]{24}$/);
    expect(Buffer.from(lease.password, "base64url")).toHaveLength(32);
    expect(lease.expiresAt).toBeGreaterThan(Date.now());
    expect(lease.expiresAt).toBeLessThanOrEqual(Date.now() + 30_000);
    expect(client).not.toHaveProperty("credential");
  });

  it("observes a real-service denial when a foreign role requests a write lease", async () => {
    // Given
    const origin = await finalizedService("workspace-write-client-role-denial");

    // When
    const response = await fetch(`${origin}/v1/projects/project-a/workspace-write-leases`, {
      method: "POST",
      headers: { authorization: rootReadIssuerAuthorization, "content-type": "application/json" },
      body: JSON.stringify({ schemaVersion: 1, generationId, repositoryId: "root", workspaceId })
    });

    // Then
    expect(response.status).toBe(403);
  });

  it.each([
    ["wrong status", { statusCode: 200 }],
    ["malformed JSON", { rawBody: "{" }],
    ["wrong content type", { contentType: "text/plain" }],
    ["missing no-store", { cacheControl: undefined }],
    ["cacheable", { cacheControl: "private" }],
    ["extra response field", { bodyChange: { extra: true } }],
    ["wrong service", { bodyChange: { serviceId: "native-other" } }],
    ["foreign Project", { bodyChange: { projectId: "project-b" } }],
    ["wrong root", { bodyChange: { repositoryId: "other" } }],
    ["wrong workspace", { bodyChange: { workspaceId: Buffer.alloc(32, 61).toString("base64url") } }],
    ["wrong generation", { bodyChange: { generationId: "b".repeat(64) } }],
    ["noncanonical username", { bodyChange: { username: "writer" } }],
    ["noncanonical password", { bodyChange: { password: "secret" } }],
    ["oversized body", { bodyChange: { username: `workspace-write-${"a".repeat(65 * 1024)}` } }],
    ["expired lease", { bodyChange: { expiresAt: Date.now() } }],
    ["overlong lease", { bodyChange: { expiresAt: Date.now() + 31_000 } }]
  ] as const)("rejects a %s lease response", async (_label, change) => {
    // Given
    const responseBody = {
      schemaVersion: 1, serviceId: "native-main", projectId: "project-a", repositoryId: "root",
      generationId, workspaceId, username: `workspace-write-${Buffer.alloc(18, 1).toString("base64url")}`,
      password: Buffer.alloc(32, 2).toString("base64url"), expiresAt: Date.now() + 25_000,
      ...("bodyChange" in change ? change.bodyChange : {})
    };
    const httpClient: NativeGitAdmissionHttpClient = {
      async request() {
        return {
          statusCode: "statusCode" in change ? change.statusCode : 201,
          contentType: "contentType" in change ? change.contentType : "application/json",
          cacheControl: "cacheControl" in change ? change.cacheControl : "no-store",
          body: Buffer.from("rawBody" in change ? change.rawBody : JSON.stringify(responseBody))
        };
      }
    };
    const client = createNativeGitWorkspaceWriteIssuerClient(issuerConnection("http://127.0.0.1:1"), httpClient);

    // When / Then
    await expect(client.issueWorkspaceWriteLease({
      projectId: "project-a", repositoryId: "root", workspaceId
    }, AbortSignal.timeout(5_000))).rejects.toThrow(NativeGitWorkspaceWriteIssuerClientError);
  });

  it.each([
    ["invalid Project", { projectId: "Project A", repositoryId: "root", workspaceId }],
    ["noncanonical workspace", { projectId: "project-a", repositoryId: "root", workspaceId: "short" }]
  ] as const)("rejects an %s request before transport", async (_label, request) => {
    // Given
    const httpClient: NativeGitAdmissionHttpClient = {
      async request() {
        throw new TestTransportReachedError();
      }
    };
    const client = createNativeGitWorkspaceWriteIssuerClient(
      issuerConnection("http://127.0.0.1:1"), httpClient
    );

    // When / Then
    await expect(client.issueWorkspaceWriteLease(request, AbortSignal.timeout(5_000)))
      .rejects.toThrow(NativeGitWorkspaceWriteIssuerClientError);
  });

  it("sends only the exact scoped request and redacts issuer credentials from failures", async () => {
    // Given
    const requests: unknown[] = [];
    const secret = Buffer.alloc(32, 61).toString("base64url");
    const httpClient: NativeGitAdmissionHttpClient = {
      async request(input) {
        requests.push(input);
        throw new Error(`transport exposed ${secret}`);
      }
    };
    const client = createNativeGitWorkspaceWriteIssuerClient({
      ...issuerConnection("http://127.0.0.1:1"), credential: { username: "issuer-a", password: secret }
    }, httpClient);

    // When
    let message = "";
    try {
      await client.issueWorkspaceWriteLease({
        projectId: "project-a", repositoryId: "root", workspaceId
      }, AbortSignal.timeout(5_000));
    } catch (error) {
      message = String(error);
    }

    // Then
    expect(message).not.toContain(secret);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      method: "POST", path: "/v1/projects/project-a/workspace-write-leases",
      body: JSON.stringify({ schemaVersion: 1, generationId, repositoryId: "root", workspaceId })
    });
  });
});

async function finalizedService(label: string): Promise<string> {
  const root = await createFinalizeRoot(label);
  const bundle = await createRootBundle();
  const service = await startFinalizeService(root);
  await activateFinalizeService(service.origin);
  await service.prepareProject(generationId, importer.hostId, projectInput("project-a"));
  const receipt = parseImportReceipt(await (await uploadRootBundle(service.origin, bundle)).json());
  expect((await finalizeRootImport(service.origin, {
    schemaVersion: 1, generationId, importNonce: receipt.importNonce, bundleDigest: receipt.bundleDigest
  })).status).toBe(200);
  return service.origin;
}

async function connection(origin: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dim-workspace-write-issuer-client-"));
  roots.push(root);
  const path = join(root, "issuer.json");
  await writeFile(path, JSON.stringify(issuerConnection(origin)), { mode: 0o600 });
  return path;
}

function issuerConnection(endpoint: string) {
  return {
    schemaVersion: 1, endpoint, serviceId: "native-main", role: "operator-workspace-write-issuer",
    hostId: workspaceWriteIssuer.hostId, generationId,
    credential: { username: workspaceWriteIssuer.username, password: workspaceWriteIssuer.password }
  } as const;
}

class TestTransportReachedError extends Error {
  readonly name = "TestTransportReachedError";
}
