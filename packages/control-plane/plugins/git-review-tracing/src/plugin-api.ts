import type { ReviewTraceRuntime } from "@slop-lab/gs-review-tracing/plugin-api";

export const reviewTraceRuntimeKind = "dim.review-tracing.runtime";

export function reviewTraceRuntimeExtension(runtime: ReviewTraceRuntime) {
  assertRuntime(runtime);
  return { kind: reviewTraceRuntimeKind, name: runtime.name, value: runtime };
}

export function reviewTraceRuntimes(extensions: readonly { readonly kind: string; readonly name: string; readonly value: object }[]): readonly ReviewTraceRuntime[] {
  const runtimes = extensions.filter(({ kind }) => kind === reviewTraceRuntimeKind).map(({ name, value }) => {
    assertRuntime(value);
    const runtime = value;
    if (runtime.name !== name) throw new Error("trace runtime extension identity conflicts");
    return runtime;
  });
  if (new Set(runtimes.map(({ name }) => name)).size !== runtimes.length) throw new Error("duplicate review trace runtime");
  return runtimes;
}

function assertRuntime(runtime: unknown): asserts runtime is ReviewTraceRuntime {
  if (!runtime || typeof runtime !== "object" || Array.isArray(runtime)
    || !("name" in runtime) || typeof runtime.name !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(runtime.name)
    || !("revision" in runtime) || typeof runtime.revision !== "string" || !/^[0-9a-f]{64}$/.test(runtime.revision)
    || !("evaluate" in runtime) || typeof runtime.evaluate !== "function") throw new Error("invalid review trace runtime");
}
