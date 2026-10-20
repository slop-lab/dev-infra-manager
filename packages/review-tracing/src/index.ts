import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export type ReadRole = "dependency" | "target";
export type ReadView = "before" | "after";
export type ReadManifest = readonly { readonly path: string; readonly role: ReadRole; readonly view: ReadView; readonly digest: string | null }[];
export type TraceChange = { readonly status: string; readonly oldPath?: string | undefined; readonly newPath?: string | undefined; readonly oldPathBytes: string; readonly newPathBytes: string };
export interface ReviewTraceRuntime {
  readonly name: string;
  readonly revision: string;
  evaluate(input: { readonly entrypoint: string; readonly changes: readonly TraceChange[]; readonly readFile: (path: string) => Promise<Buffer | undefined>; readonly readTargetFile: (path: string, view: ReadView) => Promise<Buffer | undefined>; readonly signal?: AbortSignal }): Promise<{ readonly matches: boolean; readonly manifest: ReadManifest }>;
}
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
export const reviewTraceRuntimeKind = "dim.review-tracing.runtime";
export function reviewTraceRuntimeExtension(runtime: ReviewTraceRuntime) {
  assertRuntime(runtime);
  return { kind: reviewTraceRuntimeKind, name: runtime.name, value: runtime };
}
export function reviewTraceRuntimes(extensions: readonly { readonly kind: string; readonly name: string; readonly value: object }[]): readonly ReviewTraceRuntime[] {
  const runtimes = extensions.filter(({ kind }) => kind === reviewTraceRuntimeKind).map(({ name, value }) => {
    const runtime = value as ReviewTraceRuntime; assertRuntime(runtime);
    if (runtime.name !== name) throw new Error("trace runtime extension identity conflicts"); return runtime;
  });
  if (new Set(runtimes.map(({ name }) => name)).size !== runtimes.length) throw new Error("duplicate review trace runtime");
  return runtimes;
}
function assertRuntime(runtime: ReviewTraceRuntime): void {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(runtime.name) || !/^[0-9a-f]{64}$/.test(runtime.revision) || typeof runtime.evaluate !== "function") throw new Error("invalid review trace runtime");
}
export { evaluateTrackedProject } from "./evaluate.js";

/** Binds shared enforcement semantics as well as the selected runtime. */
export const reviewTracingRevision = createHash("sha256").update(readFileSync(new URL(import.meta.url))).update(readFileSync(new URL(import.meta.url.endsWith(".ts") ? "./evaluate.ts" : "./evaluate.js", import.meta.url))).digest("hex");
