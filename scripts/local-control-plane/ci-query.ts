import { object } from "../local-uninstall/files.ts";
import { privateJson, replaceJson } from "./files.ts";

/** Developer-only update of the existing pair; no credential rotation or guest delivery. */
export async function ensureLocalCiQuery(nativeFile: string, executionFile: string, parseControlPlaneServicePair: (native: unknown, execution: unknown) => unknown): Promise<void> {
  const native = object(await privateJson(nativeFile)), execution = object(await privateJson(executionFile));
  const ci = object(native.ci), credentials = object(execution.credentials);
  if (ci.query !== undefined) { parseControlPlaneServicePair(native, execution); return; }
  if (object(ci.webhook).endpoint !== "http://execution:8080/v1/jobs") throw new Error("local Git CI does not select the paired execution endpoint");
  const candidate = { ...native, ci: { ...ci, query: credentials.query } };
  parseControlPlaneServicePair(candidate, execution);
  await replaceJson(nativeFile, candidate);
}
