import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { NativeGitAdmissionHttpClient } from "../../../../core/packages/core/src/nativeGitAdmissionSource.js";
import {
  createNativeGitRootImporterClient,
  createNodeNativeGitRootImporterClient,
  NativeGitRootImporterClientError
} from "../../../../core/packages/core/src/index.js";
import { bundleSecrets } from "../../native-git/test/bundleConfigFixture.js";
import {
  activateFinalizeService, cleanupFinalizeFixtures, createFinalizeRoot, createRootBundle,
  generationId, importer, projectInput, rootRepository, runGit, startFinalizeService
} from "../../native-git/test/nativeRootImportFinalizeFixture.js";

const servers: Server[] = [];
type ProofChange = {
  readonly outer?: Readonly<Record<string, unknown>>;
  readonly receipt?: Readonly<Record<string, unknown>>;
  readonly currentHead?: Readonly<Record<string, unknown>>;
};

afterEach(async () => {
  await cleanupFinalizeFixtures();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) =>
    server.close((error) => error === undefined ? resolve() : reject(error)))));
});

async function connection(origin: string, changes: Readonly<Record<string, unknown>> = {}): Promise<string> {
  const root = await createFinalizeRoot("client-connection");
  const path = join(root, "importer.json");
  await writeFile(path, JSON.stringify({
    schemaVersion: 1, endpoint: origin, serviceId: "native-main", role: "operator-root-importer",
    hostId: importer.hostId, generationId,
    credential: { username: importer.username, password: importer.password }, ...changes
  }), { mode: 0o600 });
  return path;
}

describe("native Git root importer host client", () => {
  it("attests and streams a bundle through the real service to finalize only the protected root", async () => {
    const root = await createFinalizeRoot("client-service");
    const bundle = await createRootBundle();
    const bundlePath = join(await createFinalizeRoot("client-bundle"), "root.bundle");
    await writeFile(bundlePath, bundle.bytes);
    const service = await startFinalizeService(root);
    await activateFinalizeService(service.origin);
    await service.prepareProject(generationId, importer.hostId, projectInput("project-a"));
    const client = await createNodeNativeGitRootImporterClient(await connection(service.origin));
    const input = {
      serviceId: "native-main", projectId: "project-a", rootRepositoryId: "root",
      protectedRef: "refs/heads/main", expectedCommit: bundle.commit,
      policy: { schemaVersion: 1, protectedRef: "refs/heads/main",
        policyRevision: "1260bff66b3d732abb336c2885d6a69a47e465369083c28875dc9cb09a9a480c",
        requiredReviewRevision: "02b474b992388d574069fe2806c9a918f3c660053df4ab6baf595d9d178ea824",
        requiredJobSetRevision: "b9763406fad20f0f816d6346d69d27eb953d7053301bd87275ba73b1f82bc8a1",
        requiredJobs: [{ name: "source", kind: "ordinary-sysbox", evidenceClass: "candidate-controlled" }],
        requiredReviewerIds: ["owner"], pathReviewerRules: [] },
      bundlePath
    } as const;

    const result = await client.importRoot(input, AbortSignal.timeout(20_000));

    expect(result).toMatchObject({ serviceId: "native-main", projectId: "project-a", generationId,
      expectedCommit: bundle.commit, resolvedTree: bundle.tree, phase: "root-imported" });
    expect((await runGit("/usr/bin/git", ["--git-dir", rootRepository(root), "rev-parse", "refs/heads/main"])).stdout.trim())
      .toBe(bundle.commit);
    expect(result.bundleSize).toBe(bundle.bytes.length);
    expect(JSON.stringify(result)).not.toContain(importer.password);
  });

  it("reads an exact imported root proof without changing service state", async () => {
    const root = await createFinalizeRoot("client-proof");
    const bundle = await createRootBundle();
    const bundlePath = join(await createFinalizeRoot("client-proof-bundle"), "root.bundle");
    await writeFile(bundlePath, bundle.bytes);
    const service = await startFinalizeService(root);
    await activateFinalizeService(service.origin);
    await service.prepareProject(generationId, importer.hostId, projectInput("project-a"));
    const client = await createNodeNativeGitRootImporterClient(await connection(service.origin));
    const receipt = await client.importRoot({ serviceId: "native-main", projectId: "project-a",
      rootRepositoryId: "root", protectedRef: "refs/heads/main", expectedCommit: bundle.commit,
      policy: { schemaVersion: 1, protectedRef: "refs/heads/main",
        policyRevision: "1260bff66b3d732abb336c2885d6a69a47e465369083c28875dc9cb09a9a480c",
        requiredReviewRevision: "02b474b992388d574069fe2806c9a918f3c660053df4ab6baf595d9d178ea824",
        requiredJobSetRevision: "b9763406fad20f0f816d6346d69d27eb953d7053301bd87275ba73b1f82bc8a1",
        requiredJobs: [{ name: "source", kind: "ordinary-sysbox", evidenceClass: "candidate-controlled" }],
        requiredReviewerIds: ["owner"], pathReviewerRules: [] },
      bundlePath }, AbortSignal.timeout(20_000));
    const databasePath = join(root, "native-idle.sqlite3");
    const before = await readFile(databasePath);

    const proof = await client.proveRoot("project-a", AbortSignal.timeout(20_000));

    expect(proof).toEqual({ schemaVersion: 3, servingGenerationId: generationId,
      ownerHostId: importer.hostId, importReceipt: receipt,
      currentHead: { projectId: "project-a", sequence: 0, protectedRef: "refs/heads/main",
        commit: receipt.expectedCommit, tree: receipt.resolvedTree, policyDigest: receipt.policyDigest } });
    expect(await readFile(databasePath)).toEqual(before);
  });

  it("replays an exactly imported root through a fresh host client without moving the protected head", async () => {
    const root = await createFinalizeRoot("client-replay");
    const bundle = await createRootBundle();
    const bundlePath = join(await createFinalizeRoot("client-replay-bundle"), "root.bundle");
    await writeFile(bundlePath, bundle.bytes);
    const service = await startFinalizeService(root);
    await activateFinalizeService(service.origin);
    await service.prepareProject(generationId, importer.hostId, projectInput("project-a"));
    const connectionPath = await connection(service.origin);
    const input = { serviceId: "native-main", projectId: "project-a", rootRepositoryId: "root",
      protectedRef: "refs/heads/main", expectedCommit: bundle.commit,
      policy: { schemaVersion: 1, protectedRef: "refs/heads/main",
        policyRevision: "1260bff66b3d732abb336c2885d6a69a47e465369083c28875dc9cb09a9a480c",
        requiredReviewRevision: "02b474b992388d574069fe2806c9a918f3c660053df4ab6baf595d9d178ea824",
        requiredJobSetRevision: "b9763406fad20f0f816d6346d69d27eb953d7053301bd87275ba73b1f82bc8a1",
        requiredJobs: [{ name: "source", kind: "ordinary-sysbox", evidenceClass: "candidate-controlled" }],
        requiredReviewerIds: ["owner"], pathReviewerRules: [] },
      bundlePath } as const;
    const first = await (await createNodeNativeGitRootImporterClient(connectionPath))
      .importRoot(input, AbortSignal.timeout(20_000));

    const replay = await (await createNodeNativeGitRootImporterClient(connectionPath))
      .importRoot(input, AbortSignal.timeout(20_000));

    expect(replay).toEqual(first);
    expect((await runGit("/usr/bin/git", ["--git-dir", rootRepository(root), "rev-parse", "refs/heads/main"])).stdout.trim())
      .toBe(bundle.commit);
  });

  it("rejects foreign host, registrar role, and wrong generation before any import mutation", async () => {
    const root = await createFinalizeRoot("client-denial");
    const service = await startFinalizeService(root);
    await activateFinalizeService(service.origin);
    await service.prepareProject(generationId, importer.hostId, projectInput("project-a"));
    const database = join(root, "native-idle.sqlite3");
    const before = await readFile(database);
    const bundlePath = join(await createFinalizeRoot("client-denied-bundle"), "root.bundle");
    await writeFile(bundlePath, "not a bundle");
    const input = { serviceId: "native-main", projectId: "project-a", rootRepositoryId: "root",
      protectedRef: "refs/heads/main", expectedCommit: "b".repeat(40), policy: {}, bundlePath } as const;
    const registrarCredential = { username: "registrar-a", password: bundleSecrets.projectRegistrar };
    const denials = [
      { hostId: "host-b" },
      { credential: registrarCredential },
      { generationId: "b".repeat(64) }
    ];
    for (const change of denials) {
      const client = await createNodeNativeGitRootImporterClient(await connection(service.origin, change));
      await expect(client.importRoot(input, AbortSignal.timeout(5_000)))
        .rejects.toThrow(NativeGitRootImporterClientError);
    }
    expect(await readFile(database)).toEqual(before);
  });

  it("rejects an upload receipt with a forged policy digest before finalization", async () => {
    const bundle = Buffer.from("bound bundle bytes");
    const bundlePath = join(await createFinalizeRoot("client-forged-receipt"), "root.bundle");
    await writeFile(bundlePath, bundle);
    let finalizeCalls = 0;
    let uploadBytes = 0;
    const server = createServer(async (request, response) => {
      response.setHeader("content-type", "application/json");
      response.setHeader("cache-control", "no-store");
      if (request.url === "/v1/operator-root-importer-identity") {
        response.end(JSON.stringify({ schemaVersion: 1, serviceId: "native-main",
          role: "operator-root-importer", hostId: importer.hostId, generationId }));
      } else if (request.url === "/v1/projects/project-a/root-import") {
        for await (const chunk of request) uploadBytes += Buffer.byteLength(chunk);
        response.end(JSON.stringify({ schemaVersion: 1, serviceId: "native-main",
          projectId: "project-a", rootRepositoryId: "root", generationId,
          importNonce: "00000000-0000-4000-8000-000000000000", protectedRef: "refs/heads/main",
          expectedCommit: "a".repeat(40), policyDigest: "f".repeat(64),
          bundleDigest: createHash("sha256").update(bundle).digest("hex"),
          bundleSize: bundle.length, phase: "bundle-durable" }));
      } else {
        finalizeCalls += 1;
        response.writeHead(500).end(JSON.stringify({ error: "finalize must not run" }));
      }
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("fake importer did not bind TCP");
    const client = await createNodeNativeGitRootImporterClient(await connection(`http://127.0.0.1:${address.port}`));

    await expect(client.importRoot({ serviceId: "native-main", projectId: "project-a",
      rootRepositoryId: "root", protectedRef: "refs/heads/main", expectedCommit: "a".repeat(40),
      policy: { schemaVersion: 1, protectedRef: "refs/heads/main",
        policyRevision: "1260bff66b3d732abb336c2885d6a69a47e465369083c28875dc9cb09a9a480c",
        requiredReviewRevision: "02b474b992388d574069fe2806c9a918f3c660053df4ab6baf595d9d178ea824",
        requiredJobSetRevision: "b9763406fad20f0f816d6346d69d27eb953d7053301bd87275ba73b1f82bc8a1",
        requiredJobs: [{ name: "source", kind: "ordinary-sysbox", evidenceClass: "candidate-controlled" }],
        requiredReviewerIds: ["owner"], pathReviewerRules: [] },
      bundlePath }, AbortSignal.timeout(5_000))).rejects.toThrow(NativeGitRootImporterClientError);
    expect(uploadBytes).toBeGreaterThan(bundle.length);
    expect(finalizeCalls).toBe(0);
  });

  it.each([
    ["foreign host", { outer: { ownerHostId: "host-b" }, receipt: {} }],
    ["schema-1 outer envelope", { outer: { schemaVersion: 1 }, receipt: {} }],
    ["schema-2 outer envelope", { outer: { schemaVersion: 2 }, receipt: {} }],
    ["stale serving generation", { outer: { servingGenerationId: "b".repeat(64) }, receipt: {} }],
    ["extra outer field", { outer: { credential: "unexpected" }, receipt: {} }],
    ["malformed import generation", { outer: {}, receipt: { generationId: "not-a-generation" } }],
    ["malformed import commit", { outer: {}, receipt: { expectedCommit: "e".repeat(39) } }],
    ["malformed import bundle", { outer: {}, receipt: { bundleDigest: "z".repeat(64) } }],
    ["wrong import phase", { outer: {}, receipt: { phase: "bundle-durable" } }],
    ["foreign current Project", { outer: {}, receipt: {}, currentHead: { projectId: "project-b" } }],
    ["negative current sequence", { outer: {}, receipt: {}, currentHead: { sequence: -1 } }],
    ["changed sequence-zero head", { outer: {}, receipt: {}, currentHead: { commit: "e".repeat(40) } }],
    ["foreign current policy", { outer: {}, receipt: {}, currentHead: { policyDigest: "f".repeat(64) } }],
    ["extra current field", { outer: {}, receipt: {}, currentHead: { credential: "unexpected" } }]
  ] satisfies readonly (readonly [string, ProofChange])[])(
  "rejects a %s imported-root proof", async (_label, change) => {
    const requests: string[] = [];
    const httpClient: NativeGitAdmissionHttpClient = {
      async request(input) {
        requests.push(`${input.method} ${input.path}`);
        const body = input.path === "/v1/operator-root-importer-identity"
          ? { schemaVersion: 1, serviceId: "native-main", role: "operator-root-importer",
            hostId: importer.hostId, generationId }
          : { schemaVersion: 3, servingGenerationId: generationId, ownerHostId: importer.hostId,
            importReceipt: { schemaVersion: 1, serviceId: "native-main", projectId: "project-a",
              rootRepositoryId: "root", generationId,
              importNonce: "00000000-0000-4000-8000-000000000000",
              protectedRef: "refs/heads/main", expectedCommit: "a".repeat(40),
              resolvedTree: "b".repeat(40), policyDigest: "c".repeat(64),
              bundleDigest: "d".repeat(64), bundleSize: 123, phase: "root-imported",
              ...change.receipt },
            currentHead: { projectId: "project-a", sequence: 0, protectedRef: "refs/heads/main",
              commit: "a".repeat(40), tree: "b".repeat(40), policyDigest: "c".repeat(64),
              ...("currentHead" in change ? change.currentHead : {}) },
            ...change.outer };
        return { statusCode: 200, contentType: "application/json", cacheControl: "no-store",
          body: Buffer.from(JSON.stringify(body)) };
      }
    };
    const client = createNativeGitRootImporterClient({ schemaVersion: 1,
      endpoint: "http://127.0.0.1:1", serviceId: "native-main", role: "operator-root-importer",
      hostId: importer.hostId, generationId,
      credential: { username: importer.username, password: importer.password } }, httpClient);

    await expect(client.proveRoot("project-a", AbortSignal.timeout(5_000)))
      .rejects.toThrow(NativeGitRootImporterClientError);

    expect(requests).toEqual(["GET /v1/operator-root-importer-identity",
      "GET /v1/projects/project-a/root-import/proof"]);
  });
});
