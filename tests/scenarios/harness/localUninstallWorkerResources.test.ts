import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { collectWorkerClaims } from "../../../scripts/local-uninstall/worker-resources.ts";
const id = "11111111-1111-4111-8111-111111111111";
const ownership = { executionId: id, workerId: "worker", slotId: "slot", generationId: "a".repeat(64) };
function journal(kind: string) {
  const event = { executionKind: kind, ...(kind.startsWith("task/") ? { taskType: kind.slice(5) } : {}) };
  return { requestId: id, assignment: { id, workerId: "worker", slotId: "slot", generationId: "a".repeat(64), phase: "running",
    event, grant: { ...ownership, event } } };
}
it("derives exact qemu supervisor and rootfs identities from a private slot journal", async () => {
  const root = await mkdtemp(join(tmpdir(), "dim-uninstall-worker-"));
  try {
    await mkdir(join(root, "slot"), { mode: 0o700 });
    await writeFile(join(root, "slot", "execution.json"), JSON.stringify(journal("qemu")), { mode: 0o600 });
    const claims = await collectWorkerClaims([root]);
    const name = `dim-native-ci-${createHash("sha256").update(id).digest("hex").slice(0, 20)}`;
    expect(claims.map((claim) => claim.name)).toEqual([name, `${name}-rootfs`]);
    expect(claims[0]?.labels).toMatchObject({ "dim.host": "worker", "dim.capacity": "slot", "dim.kind": "qemu", "dim.attempt": id });
    expect(claims[0]?.labels["dim.digest"]).toMatch(/^sha256:[0-9a-f]{64}$/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
it("supports only known task ownership and rejects symlink traversal", async () => {
  const root = await mkdtemp(join(tmpdir(), "dim-uninstall-worker-"));
  try {
    await writeFile(join(root, "execution.json"), JSON.stringify(journal("task/review-tracing")), { mode: 0o600 });
    expect(await collectWorkerClaims([root])).toEqual([{ kind: "container", name: `dim-review-trace-${id}`, labels: { "dev.dim.review-tracing.owner": id } }]);
    await writeFile(join(root, "execution.json"), JSON.stringify(journal("task/unknown")));
    await expect(collectWorkerClaims([root])).rejects.toThrow(/unknown task handler/);
    await rm(join(root, "execution.json"));
    await symlink(root, join(root, "loop"));
    await expect(collectWorkerClaims([root])).rejects.toThrow(/symlink/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
