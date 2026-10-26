import { gitPolicy } from "../../../support/git-policy.js";
import { dimWorkflowCompiler } from "@slop-lab/dim-control-plane-plugin-ci-workflows";
import { request as httpRequest } from "node:http";
import { watch, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { parseManagedGitServiceConfig } from "@slop-lab/dim-control-plane-admin/service-pair";
import { configuredManagedGitFixture } from "../../../support/managed-git-service.js";
import { bundleSecrets, idleNativeConfig } from "./bundleConfigFixture.js";

const generationId = "a".repeat(64);
const activationToken = Buffer.alloc(32, 42).toString("base64url");
const importer = {
  hostId: "host-a", username: "root-importer-a", password: bundleSecrets.projectRootImporter
} as const;

describe("native root import request admission", () => {
  it("rejects unauthenticated and concurrent uploads promptly while an authorized body remains incomplete", async () => {
    const root = await mkdtemp(join(tmpdir(), "dim-native-root-import-admission-"));
    const service = await configuredManagedGitFixture({ workflowCompiler: dimWorkflowCompiler,
      config: parseManagedGitServiceConfig({
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
        serviceId: "native-main", projectId: "project-a", repositoryId: "root"
      });
      const endpoint = `${origin}/v1/projects/project-a/repositories/root/import`;
      const finalizeEndpoint = `${endpoint}/finalize`;
      const authorization = `Basic ${Buffer.from(`${importer.username}:${importer.password}`).toString("base64")}`;
      const prelude = Buffer.from(`${JSON.stringify({
        schemaVersion: 1, generationId, serviceId: "native-main", projectId: "project-a",
        repositoryId: "root", protectedRef: "refs/heads/main", expectedCommit: "c".repeat(40),
        policy: gitPolicy({ "code-review": { requiredReviewerIds: ["owner"], pathReviewerRules: [] } })
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
