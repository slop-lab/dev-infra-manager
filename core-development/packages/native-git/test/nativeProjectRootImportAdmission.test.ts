import { request as httpRequest } from "node:http";
import { watch, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { parseNativeGitBundleConfig } from "../../../../core/packages/native-git/src/bundle-config.js";
import { configuredNativeGitBundleServer } from "../../../../core/packages/native-git/src/native-bundle-server.js";
import { bundleSecrets, idleNativeConfig } from "./bundleConfigFixture.js";

const generationId = "a".repeat(64);
const activationToken = Buffer.alloc(32, 42).toString("base64url");
const importer = {
  hostId: "host-a", username: "root-importer-a", password: bundleSecrets.projectRootImporter
} as const;

describe("native root import request admission", () => {
  it("rejects unauthenticated and concurrent uploads promptly while an authorized body remains incomplete", async () => {
    const root = await mkdtemp(join(tmpdir(), "dim-native-root-import-admission-"));
    const service = await configuredNativeGitBundleServer({
      config: parseNativeGitBundleConfig({
        ...idleNativeConfig(),
        projectRegistrars: [{ hostId: "host-a", username: "registrar-a", password: bundleSecrets.projectRegistrar }],
        projectRootImporters: [importer],
        humanReviewers: [{ reviewerId: "owner", username: "human-reviewer-owner", password: bundleSecrets.humanReviewer }]
      }),
      stateDirectory: root,
      readinessToken: Buffer.alloc(32, 41).toString("base64url"),
      activationToken,
      expectedGenerationId: generationId
    });
    let stalled: ReturnType<typeof httpRequest> | undefined;
    try {
      const origin = await service.listen("127.0.0.1", 0);
      const activated = await fetch(`${origin}/v1/activation`, {
        method: "POST",
        headers: { authorization: `Bearer ${activationToken}`, "content-type": "application/json" },
        body: JSON.stringify({ schemaVersion: 1, generationId })
      });
      expect(activated.status).toBe(200);
      await service.prepareProject(generationId, "host-a", {
        serviceId: "native-main", projectId: "project-a", rootRepositoryId: "root"
      });
      const endpoint = `${origin}/v1/projects/project-a/root-import`;
      const finalizeEndpoint = `${endpoint}/finalize`;
      const authorization = `Basic ${Buffer.from(`${importer.username}:${importer.password}`).toString("base64")}`;
      const prelude = Buffer.from(`${JSON.stringify({
        schemaVersion: 1, generationId, serviceId: "native-main", projectId: "project-a",
        rootRepositoryId: "root", protectedRef: "refs/heads/main", expectedCommit: "c".repeat(40),
        policy: {
          schemaVersion: 1, protectedRef: "refs/heads/main",
          policyRevision: "1260bff66b3d732abb336c2885d6a69a47e465369083c28875dc9cb09a9a480c",
          requiredReviewRevision: "02b474b992388d574069fe2806c9a918f3c660053df4ab6baf595d9d178ea824",
          requiredJobSetRevision: "b9763406fad20f0f816d6346d69d27eb953d7053301bd87275ba73b1f82bc8a1",
          requiredJobs: [{ name: "source", kind: "ordinary-sysbox", evidenceClass: "candidate-controlled" }],
          requiredReviewerIds: ["owner"],
          pathReviewerRules: []
        }
      })}\n`);
      const changes = watch(root, { recursive: true, signal: AbortSignal.timeout(5_000) });
      const intentCreated = (async () => {
        for await (const _change of changes) {
          const database = new DatabaseSync(join(root, "native-idle.sqlite3"), { readOnly: true });
          try {
            if (database.prepare("SELECT 1 FROM native_project_root_import WHERE project_id = ?")
              .get("project-a") !== undefined) return;
          } finally {
            database.close();
          }
        }
        throw new Error("root import intent was not claimed");
      })();
      stalled = httpRequest(endpoint, {
        method: "POST",
        headers: { authorization, "content-type": "application/octet-stream", "content-length": prelude.length + 1024 }
      });
      stalled.on("error", () => undefined);
      stalled.flushHeaders();
      stalled.write(prelude);
      await intentCreated;
      const before = await readFile(join(root, "native-idle.sqlite3"));

      const unauthenticated = await fetch(endpoint, {
        method: "POST", headers: { "content-type": "application/octet-stream" },
        body: "x", signal: AbortSignal.timeout(2_000)
      });
      const concurrent = await fetch(endpoint, {
        method: "POST", headers: { authorization, "content-type": "application/octet-stream" },
        body: "x", signal: AbortSignal.timeout(2_000)
      });
      const unauthenticatedFinalize = await fetch(finalizeEndpoint, {
        method: "POST", headers: { "content-type": "application/json" },
        body: "{}", signal: AbortSignal.timeout(2_000)
      });
      const concurrentFinalize = await fetch(finalizeEndpoint, {
        method: "POST", headers: { authorization, "content-type": "application/json" },
        body: "{}", signal: AbortSignal.timeout(2_000)
      });

      expect(unauthenticated.status).toBe(401);
      expect(concurrent.status).toBe(503);
      expect(unauthenticatedFinalize.status).toBe(401);
      expect(concurrentFinalize.status).toBe(503);
      expect(await readFile(join(root, "native-idle.sqlite3"))).toEqual(before);
    } finally {
      stalled?.destroy();
      await service.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
