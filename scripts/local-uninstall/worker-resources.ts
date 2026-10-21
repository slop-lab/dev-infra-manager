import { createHash } from "node:crypto";
import { readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { metadata, object, readJson, text, uuid } from "./files.ts";
import type { DockerClaim } from "./types.ts";

/** Read only approved worker roots; a slot journal ends traversal before candidate files. */
export async function collectWorkerClaims(roots: readonly string[]): Promise<DockerClaim[]> {
  const claims: DockerClaim[] = [], visited = new Set<string>();
  let entries = 0;
  async function walk(path: string, depth: number): Promise<void> {
    if (depth > 8 || ++entries > 10_000) throw new Error("worker state traversal exceeds its bound");
    const absolute = resolve(path);
    if (visited.has(absolute)) return;
    visited.add(absolute);
    const stat = await metadata(absolute);
    if (stat === undefined) return;
    if (await realpath(absolute) !== absolute || !stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0) {
      throw new Error(`unsafe worker state directory: ${absolute}`);
    }
    const journalPath = join(absolute, "execution.json"), journalStat = await metadata(journalPath);
    if (journalStat !== undefined) {
      if ((journalStat.mode & 0o077) !== 0 || journalStat.size > 1024 * 1024) throw new Error(`unsafe worker journal: ${journalPath}`);
      claims.push(...journalClaims(await readJson(journalPath)));
      return;
    }
    const children = await readdir(absolute, { withFileTypes: true });
    if (children.length > 10_000 - entries) throw new Error("worker state directory exceeds its bound");
    entries += children.length;
    for (const child of children) {
      if (child.isSymbolicLink()) throw new Error(`symlink in worker state: ${join(absolute, child.name)}`);
      if (child.isDirectory()) await walk(join(absolute, child.name), depth + 1);
    }
  }
  for (const root of roots) {
    if (!isAbsolute(root)) throw new Error("worker state roots must be absolute");
    await walk(root, 0);
  }
  return [...new Map(claims.map((claim) => [`${claim.kind}:${claim.name}`, claim])).values()];
}

function journalClaims(input: unknown): DockerClaim[] {
  const journal = object(input);
  if (Object.keys(journal).some((key) => !["requestId", "assignment", "root", "result"].includes(key))) throw new Error("unknown worker journal fields");
  uuid(journal.requestId);
  if (journal.assignment === undefined) {
    if (journal.root !== undefined || journal.result !== undefined) throw new Error("worker journal has resources without an assignment");
    return [];
  }
  const assignment = object(journal.assignment), event = object(assignment.event);
  const executionId = uuid(assignment.id), workerId = identifier(assignment.workerId), slotId = identifier(assignment.slotId);
  const generationId = text(assignment.generationId);
  if (!/^[0-9a-f]{64}$/.test(generationId) || !["assigned", "running", "recovering", "finished"].includes(text(assignment.phase))) {
    throw new Error("invalid worker assignment ownership");
  }
  const kind = text(event.executionKind);
  if (kind.startsWith("task/")) {
    if (kind !== "task/review-tracing" || event.taskType !== "review-tracing") throw new Error("unknown task handler resource ownership");
    if (assignment.grant !== undefined) verifyGrant(object(assignment.grant), executionId, workerId, slotId, generationId);
    return [{ kind: "container", name: `dim-review-trace-${executionId}`, labels: { "dev.dim.review-tracing.owner": executionId } }];
  }
  if (kind !== "ordinary-sysbox" && kind !== "qemu") throw new Error("unknown CI worker resource kind");
  if (assignment.grant === undefined) {
    if (journal.root !== undefined || journal.result !== undefined) throw new Error("CI resources lack a grant");
    return [];
  }
  const grant = object(assignment.grant);
  verifyGrant(grant, executionId, workerId, slotId, generationId);
  if (object(grant.event).executionKind !== kind) throw new Error("CI grant runtime ownership differs");
  const name = `dim-native-ci-${createHash("sha256").update(executionId).digest("hex").slice(0, 20)}`;
  const claim = (resourceKind: string, resourceName: string): DockerClaim => {
    const fields = ["true", "dim", workerId, slotId, generationId, executionId, executionId, resourceKind];
    const hash = createHash("sha256").update("dim-native-ordinary-resource-v1", "ascii");
    for (const field of fields) hash.update(`${Buffer.byteLength(field)}:`, "ascii").update(field);
    return { kind: "container", name: resourceName, labels: {
      "dim.managed": "true", "dim.owner": "dim", "dim.host": workerId, "dim.capacity": slotId,
      "dim.admission-generation": generationId, "dim.attempt": executionId, "dim.resource": executionId,
      "dim.kind": resourceKind, "dim.digest": `sha256:${hash.digest("hex")}`
    } };
  };
  return kind === "qemu" ? [claim("qemu", name), claim("qemu-rootfs", `${name}-rootfs`)] : [claim("sysbox", name)];
}
function identifier(input: unknown): string {
  const value = text(input);
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(value)) throw new Error("invalid worker or slot identity");
  return value;
}
function verifyGrant(grant: Record<string, unknown>, executionId: string, workerId: string, slotId: string, generationId: string): void {
  if (grant.executionId !== executionId || grant.workerId !== workerId || grant.slotId !== slotId || grant.generationId !== generationId) {
    throw new Error("worker grant ownership conflicts with its assignment");
  }
}
