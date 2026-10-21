/** Extension interfaces for brokered review predicate runtimes. */
export type ReadRole = "dependency" | "target";
export type ReadView = "before" | "after";
export type ReadManifest = readonly { readonly path: string; readonly role: ReadRole; readonly view: ReadView; readonly digest: string | null }[];
export type TraceChange = { readonly status: string; readonly oldPath?: string | undefined; readonly newPath?: string | undefined; readonly oldPathBytes: string; readonly newPathBytes: string };
export interface ReviewTraceRuntime {
  readonly name: string;
  readonly revision: string;
  evaluate(input: { readonly entrypoint: string; readonly changes: readonly TraceChange[]; readonly readFile: (path: string) => Promise<Buffer | undefined>; readonly readTargetFile: (path: string, view: ReadView) => Promise<Buffer | undefined>; readonly signal?: AbortSignal }): Promise<{ readonly matches: boolean; readonly manifest: ReadManifest }>;
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
