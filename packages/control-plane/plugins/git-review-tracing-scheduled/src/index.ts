import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ControlPlanePlugin } from "@slop-lab/dim-control-plane-core/plugin-api";
import { assertTracePath, createReadTracker, traceDigest } from "@slop-lab/dim-git-review-tracing";
import { reviewTraceRuntimeExtension, type ReadRole, type ReadView, type ReviewTraceRuntime } from "@slop-lab/dim-git-review-tracing/plugin-api";
import { runScheduledTask, taskClientRevision } from "@slop-lab/dim-service-client-execution/tasks";

type Configuration = { readonly endpoint: string; readonly generationId: string; readonly handlerRevision: string;
  readonly credential: { readonly username: string; readonly password: string } };
function configuration(raw: unknown): Configuration {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).sort().join(",") !== "credential,endpoint,generationId,handlerRevision") throw new Error("scheduled review requires endpoint, generationId, handlerRevision and credential");
  const value = raw as Record<string, unknown>;
  if (typeof value.endpoint !== "string" || typeof value.generationId !== "string" || typeof value.handlerRevision !== "string" || !/^[a-f0-9]{64}$/.test(value.generationId) || !/^[a-f0-9]{64}$/.test(value.handlerRevision)) throw new Error("invalid scheduled review identity");
  const url = new URL(value.endpoint);
  if (url.origin !== value.endpoint || url.username || url.password || url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname))) throw new Error("scheduled review endpoint must be an HTTPS origin or loopback HTTP origin");
  const credential = value.credential;
  if (credential === null || typeof credential !== "object" || Array.isArray(credential) || Object.keys(credential).sort().join(",") !== "password,username") throw new Error("invalid task issuer credential");
  const selected = credential as Record<string, unknown>;
  if (typeof selected.username !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(selected.username) || typeof selected.password !== "string" || !/^[A-Za-z0-9_-]{43,}$/.test(selected.password)) throw new Error("invalid task issuer credential");
  return { endpoint: value.endpoint, generationId: value.generationId, handlerRevision: value.handlerRevision, credential: { username: selected.username, password: selected.password } };
}
const implementationRevision = createHash("sha256").update(readFileSync(new URL(import.meta.url))).digest("hex");
export function createScheduledReviewTraceRuntime(raw: Configuration): ReviewTraceRuntime {
  const config = configuration(raw);
  return {
    name: "node-scheduled", revision: traceDigest({ implementationRevision, taskClientRevision, config }),
    async evaluate(input) {
      const tracker = createReadTracker(input);
      await tracker.read(input.entrypoint, "dependency");
      const result = await runScheduledTask({ ...config, taskType: "review-tracing", payload: { entrypoint: input.entrypoint, changes: input.changes },
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        async exchange(operation, value) {
          if (operation !== "read" || value === null || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== "path,role,view") throw new Error("invalid review task exchange");
          const read = value as Record<string, unknown>;
          if (typeof read.path !== "string" || read.role !== "dependency" && read.role !== "target" || read.view !== "before" && read.view !== "after") throw new Error("invalid review task read");
          assertTracePath(read.path);
          const content = await tracker.read(read.path, read.role as ReadRole, read.view as ReadView);
          return { content: content === undefined ? null : content.toString("base64") };
        }
      });
      if (typeof result !== "boolean") throw new Error("scheduled review returned a non-boolean decision");
      return { matches: result, manifest: tracker.manifest() };
    }
  };
}
export const controlPlanePlugin: ControlPlanePlugin = { apiVersion: 1, name: "review-tracing-scheduled", configure(raw) {
  return { extensions: [reviewTraceRuntimeExtension(createScheduledReviewTraceRuntime(configuration(raw)))],
    async start() { return { async close() {} }; } };
} };
