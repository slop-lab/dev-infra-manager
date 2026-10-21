import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import type { ReadRole, ReadView, ReadManifest } from "./plugin-api.js";
export function assertTracePath(path: string): void {
  if (typeof path !== "string" || path.length === 0 || Buffer.byteLength(path) > 1024 || path.startsWith("/") || path.includes("\\") || path.includes("\0") || path.split("/").some((part) => part === "" || part === "." || part === "..") || Buffer.from(path).toString() !== path) throw new Error("trace read requires a normalized repository path");
}
export function traceDigest(value: unknown): string { return createHash("sha256").update("dim-review-tracing-v1\0").update(JSON.stringify(value)).digest("hex"); }
export function createReadTracker(input: { readonly readFile: (path: string) => Promise<Buffer | undefined>; readonly readTargetFile: (path: string, view: ReadView) => Promise<Buffer | undefined> }) {
  const reads = new Map<string, ReadManifest[number]>();
  let bytes = 0;
  const requested = new Set<string>();
  return {
    async read(path: string, role: ReadRole, view: ReadView = "after"): Promise<Buffer | undefined> {
      assertTracePath(path);
      if (role !== "dependency" && role !== "target" || view !== "before" && view !== "after" || role === "dependency" && view !== "after") throw new Error("invalid trace read role or view");
      const key = `${path}\0${role}\0${view}`;
      if (requested.size >= 512 && !requested.has(key)) throw new Error("trace read count exceeds 512");
      requested.add(key);
      const value = role === "dependency" ? await input.readFile(path) : await input.readTargetFile(path, view);
      if (value !== undefined && (!Buffer.isBuffer(value) || value.length > 1024 * 1024)) throw new Error("trace file exceeds 1 MiB");
      bytes += value?.length ?? 0;
      if (bytes > 16 * 1024 * 1024) throw new Error("trace reads exceed 16 MiB");
      const digest = value === undefined ? null : createHash("sha256").update(value).digest("hex");
      if (reads.has(key) && reads.get(key)?.digest !== digest) throw new Error("trace snapshot changed during evaluation");
      reads.set(key, { path, role, view, digest });
      return value === undefined ? undefined : Buffer.from(value);
    },
    manifest(): ReadManifest { return [...reads.values()].sort((a, b) => `${a.path}\0${a.role}\0${a.view}`.localeCompare(`${b.path}\0${b.role}\0${b.view}`)); }
  };
}
export { evaluateTrackedProject } from "./evaluate.js";

/** Binds shared enforcement semantics as well as the selected runtime. */
export const reviewTracingRevision = createHash("sha256").update(readFileSync(new URL(import.meta.url))).update(readFileSync(new URL(import.meta.url.endsWith(".ts") ? "./plugin-api.ts" : "./plugin-api.js", import.meta.url))).update(readFileSync(new URL(import.meta.url.endsWith(".ts") ? "./evaluate.ts" : "./evaluate.js", import.meta.url))).digest("hex");
