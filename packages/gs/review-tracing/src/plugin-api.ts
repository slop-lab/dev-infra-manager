/** Runtime-neutral interfaces for brokered review predicate evaluation. */
export type ReadRole = "dependency" | "target";
export type ReadView = "before" | "after";
export type ReadManifest = readonly { readonly path: string; readonly role: ReadRole; readonly view: ReadView; readonly digest: string | null }[];
export type TraceChange = { readonly status: string; readonly oldPath?: string | undefined; readonly newPath?: string | undefined; readonly oldPathBytes: string; readonly newPathBytes: string };
export interface ReviewTraceRuntime {
  readonly name: string;
  readonly revision: string;
  evaluate(input: { readonly entrypoint: string; readonly changes: readonly TraceChange[]; readonly readFile: (path: string) => Promise<Buffer | undefined>; readonly readTargetFile: (path: string, view: ReadView) => Promise<Buffer | undefined>; readonly signal?: AbortSignal }): Promise<{ readonly matches: boolean; readonly manifest: ReadManifest }>;
}
