import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { executionArtifactChunkSchema, executionArtifactManifestSchema, type ExecutionArtifactManifest } from "@slop-lab/dim-contracts-execution";
import { executionResultSchema } from "@slop-lab/dim-contracts-ci/aggregate";
import { runExecutionWorker } from "../../../../packages/host/plugins/execution-worker/src/worker.js";
import { sysboxBackend } from "../../../../packages/host/plugins/execution-worker/src/backends/sysbox.js";
import type { ExecutionBackend } from "../../../../packages/host/plugins/execution-worker/src/backend.js";
import { ExecutionServiceUnavailableError, type ExecutionWorkerClient } from "../../../../packages/host/plugins/execution-worker/src/client.js";
import { assignment, grant } from "../../../contracts/ci/executionFixture.js";
import { ExecutorRunner } from "./sysboxFixture.js";
import { artifactTar } from "./artifactTarFixture.js";

it.each(["current", "foreign-nonce", "upload-timeout"] as const)("persists and uploads %s backend handoff through the normal worker lifecycle", async condition => {
  const directory = await mkdtemp(join(tmpdir(), "dim-artifact-worker-")), stop = new AbortController();
  try {
    const selected = assignment(), authorized = { ...selected, grant: grant(selected) }, runner = new ExecutorRunner();
    const bytes = Buffer.from('{"nonce":"fffccb07-6199-4772-b225-0556b8b61166"}\n'); runner.archive = artifactTar("private.json", bytes);
    let handoffNonce: string | undefined;
    const backend: ExecutionBackend = {
      kind: "ordinary-sysbox", cleanup: sysboxBackend.cleanup,
      async run(input) {
        handoffNonce = input.artifactNonce;
        const path = join(input.root, "workspace/.dim-ci-artifacts/private.json");
        runner.afterRemoval = () => chmod(path, 0);
        const completed = await sysboxBackend.run({ ...input, async acquireCandidate({ scriptFile }) {
          await mkdir(join(input.root, "workspace/.dim-ci-artifacts"), { recursive: true });
          await writeFile(path, bytes, { mode: 0o600 }); await writeFile(scriptFile, "true\n");
        } });
        if (completed.artifactSource === undefined) throw new Error("handoff missing");
        return condition !== "foreign-nonce" ? completed : { ...completed, artifactSource: { ...completed.artifactSource, nonce: "00000000-0000-4000-8000-000000000000" } };
      }
    };
    const chunks = new Map<string, Buffer[]>(); let retained: ExecutionArtifactManifest | undefined, reports = 0;
    const client: ExecutionWorkerClient = {
      async claim(requestId) { return { ...authorized, requestId }; }, async renew() { return 60_000; },
      async candidate() { throw new Error("fixture acquisition does not contact Native Git"); },
      async exchange() { throw new Error("not a task-message operation"); }, async recover() { throw new Error("completed work must report"); },
      async artifactChunk(_assignment, value) {
        if (condition === "upload-timeout") throw new ExecutionServiceUnavailableError("storage unavailable", "unavailable");
        const chunk = executionArtifactChunkSchema.parse(value), parts = chunks.get(chunk.artifact.name) ?? [];
        parts.push(Buffer.from(chunk.base64, "base64")); chunks.set(chunk.artifact.name, parts);
      },
      async finalizeArtifacts(_assignment, value) { retained = executionArtifactManifestSchema.parse(value); },
      async report(_assignment, value) {
        expect(executionResultSchema.parse(value).result).toBe(condition === "upload-timeout" ? "failure" : "success");
        for (const raw of [JSON.stringify(value), await readFile(join(directory, "execution.json"), "utf8"), ...(condition === "upload-timeout" ? [await readFile(join(directory, "artifacts-" + authorized.id, "upload-timeout.json"), "utf8")] : [])]) {
          expect(raw).not.toContain("artifactSource"); expect(raw).not.toContain('"identity"');
          if (handoffNonce === undefined) throw new Error("worker nonce missing"); expect(raw).not.toContain(handoffNonce);
        }
        reports++; stop.abort();
      }
    };
    await runExecutionWorker({ directory, client, backend, runner, gitEndpoint: "http://127.0.0.1:1234", gitExecutable: "/usr/bin/git", signal: stop.signal, ...(condition === "upload-timeout" ? { artifactUploadTimeoutMilliseconds: 1 } : {}) });
    if (condition === "upload-timeout") {
      const manifest = executionArtifactManifestSchema.parse(JSON.parse(await readFile(join(directory, "artifacts-" + authorized.id, "manifest.json"), "utf8")));
      expect(manifest.availability).toBe("complete"); const file = manifest.artifacts.find(entry => entry.name === "files/private.json");
      if (file === undefined) throw new Error("retained private artifact missing"); expect(await readFile(join(directory, "artifacts-" + authorized.id, file.id))).toEqual(bytes);
      expect(reports).toBe(1); return;
    }
    expect(reports).toBe(1); expect(retained?.availability).toBe(condition === "current" ? "complete" : "unavailable");
    expect(chunks.has("files/private.json")).toBe(condition === "current");
    if (condition === "current") expect(Buffer.concat(chunks.get("files/private.json") ?? [])).toEqual(bytes);
    expect(chunks.has("logs/stdout.log")).toBe(true); expect(chunks.has("logs/stderr.log")).toBe(true);
    expect((await readdir(directory)).some(name => name.startsWith("work-") || name.startsWith("artifacts-") || name === "execution.json")).toBe(false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
