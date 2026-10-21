import { reviewTraceRuntimes, type ReviewTraceRuntime } from "@slop-lab/dim-review-tracing/plugin-api";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ControlPlanePlugin } from "@slop-lab/dim-control-plane-core/plugin-api";
import { repositoryExtension } from "@slop-lab/dim-control-plane-plugin-git-repositories/plugin-api";
import { reviewChangeMatcherExtension } from "@slop-lab/dim-control-plane-plugin-code-review/plugin-api";
import { assertTracePath, reviewTracingRevision, evaluateTrackedProject, traceDigest } from "@slop-lab/dim-review-tracing";

function parseOptions(raw: unknown): { entrypoint: string; runtime: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw) || Object.keys(raw).some((key) => key !== "entrypoint" && key !== "runtime")) throw new Error("tracked-project requires entrypoint and runtime");
  const entrypoint: unknown = Reflect.get(raw, "entrypoint"), runtime: unknown = Reflect.get(raw, "runtime");
  if (typeof entrypoint !== "string" || typeof runtime !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(runtime)) throw new Error("invalid tracked-project options");
  assertTracePath(entrypoint); return { entrypoint, runtime };
}
const implementationRevision = createHash("sha256").update(readFileSync(new URL(import.meta.url))).digest("hex");
export function prepareReviewTracing() {
  let runtimes: readonly ReviewTraceRuntime[] = [];
  const matcher = {
    name: "tracked-project",
    get revision() { return traceDigest({ implementationRevision, reviewTracingRevision, runtimes: runtimes.map(({ name, revision }) => ({ name, revision })).sort((a, b) => a.name.localeCompare(b.name)) }); },
    validate(raw: unknown) { const options = parseOptions(raw); if (!runtimes.some(({ name }) => name === options.runtime)) throw new Error(`review trace runtime '${options.runtime}' unavailable`); },
    async matches(input: Parameters<Parameters<typeof reviewChangeMatcherExtension>[0]["matches"]>[0]) {
      const options = parseOptions(input.options);
      const runtime = runtimes.find(({ name }) => name === options.runtime);
      if (runtime === undefined || input.readBaseFile === undefined) throw new Error("tracked-project requires its runtime and exact protected snapshot");
      return evaluateTrackedProject({ runtime, entrypoint: options.entrypoint, changes: input.changes, readBaseFile: input.readBaseFile, readCandidateFile: input.readCandidateFile });
    }
  };
  return {
    requiresExtensions: [{ kind: "dim.git-repositories.service", name: "default" }, { kind: "dim.code-review.service", name: "default" }],
    extensions: [reviewChangeMatcherExtension(matcher), repositoryExtension({ name: "review-tracing", attach(context) {
      runtimes = reviewTraceRuntimes(context.extensions);
      return Promise.resolve({ async close() {} });
    } })],
    async start() { return { async close() {} }; }
  };
}
export const controlPlanePlugin: ControlPlanePlugin = { apiVersion: 1, name: "review-tracing", configure(raw) {
  if (raw !== undefined && (typeof raw !== "object" || raw === null || Array.isArray(raw) || Object.keys(raw).length !== 0)) throw new Error("review-tracing takes an empty configuration");
  return prepareReviewTracing();
} };
