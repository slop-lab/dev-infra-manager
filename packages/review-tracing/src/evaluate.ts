import { createHash } from "node:crypto";
import { assertTracePath, createReadTracker, traceDigest, type ReadManifest, type ReviewTraceRuntime, type TraceChange } from "./index.js";

/** The broker observes every read itself: a runtime cannot omit reads from its returned manifest. */
export async function evaluateTrackedProject(input: {
  readonly runtime: ReviewTraceRuntime; readonly entrypoint: string; readonly changes: readonly TraceChange[];
  readonly readBaseFile: (path: string) => Promise<Buffer | undefined>;
  readonly readCandidateFile: (path: string) => Promise<Buffer | undefined>;
}): Promise<{ readonly matches: boolean; readonly evidenceDigest: string }> {
  assertTracePath(input.entrypoint);
  async function evaluate(base: boolean) {
    const tracker = createReadTracker({ readFile: base ? input.readBaseFile : input.readCandidateFile,
      readTargetFile: (path, view) => base || view === "before" ? input.readBaseFile(path) : input.readCandidateFile(path) });
    const entry = await tracker.read(input.entrypoint, "dependency");
    if (entry === undefined) throw new Error("trace entrypoint is absent");
    const result = await input.runtime.evaluate({ entrypoint: input.entrypoint, changes: input.changes,
      readFile: (path) => tracker.read(path, "dependency"), readTargetFile: (path, view) => tracker.read(path, "target", view), signal: AbortSignal.timeout(10_000) });
    if (typeof result.matches !== "boolean") throw new Error("trace runtime returned invalid decision");
    return { matches: result.matches, manifest: tracker.manifest() };
  }
  let baseline: { matches: boolean; manifest: ReadManifest } | undefined;
  try { baseline = await evaluate(true); } catch { /* An absent/broken old predicate must be repairable through review. */ }
  const candidate = await evaluate(false); // Fail closed: candidate errors cannot yield an approval decision.
  const baselineDependencies = new Map((baseline?.manifest ?? []).filter(({ role }) => role === "dependency").map((read) => [read.path, read.digest]));
  const candidateDependencies = new Set(candidate.manifest.filter(({ role }) => role === "dependency").map(({ path }) => path));
  const compared: { path: string; before: string | null; after: string | null }[] = [];
  let dependencyChanged = baseline === undefined;
  let comparisonBytes = 0;
  for (const [path, before] of baselineDependencies) {
    const value = await input.readCandidateFile(path);
    comparisonBytes += value?.length ?? 0;
    if (comparisonBytes > 16 * 1024 * 1024) throw new Error("trace dependency comparison exceeds 16 MiB");
    const after = value === undefined ? null : createHash("sha256").update(value).digest("hex");
    compared.push({ path, before, after });
    if (before !== after || !candidateDependencies.has(path)) dependencyChanged = true;
  }
  if ([...candidateDependencies].some((path) => !baselineDependencies.has(path))) dependencyChanged = true;
  return { matches: candidate.matches || dependencyChanged,
    evidenceDigest: traceDigest({ runtime: { name: input.runtime.name, revision: input.runtime.revision }, entrypoint: input.entrypoint,
      baseline: baseline ?? { error: "base-evaluation-failed" }, candidate, compared }) };
}
