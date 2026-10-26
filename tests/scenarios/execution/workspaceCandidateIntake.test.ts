import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { installedExecutionFixture } from "./installedExecutionFixture.js";
import { generationId, runGit, workspaceWriteIssuerAuthorization } from "../../control-plane/plugins/git-repositories/nativeRootImportFinalizeFixture.js";
import { reviewWorkspaceId } from "../../control-plane/plugins/git-ci/nativeBundleReviewFixture.js";
import { result } from "../../contracts/ci/executionFixture.js";
import { runCommand } from "../web-lifecycle/process.js";

it("dispatches one workspace-requested required job and reports a trusted fixture process, not Sysbox acceptance", async () => {
  const f = await installedExecutionFixture();
  f.setPublicationAvailable(true);
  async function completeFixtureJob() {
    const claim = await f.claim(), root = await mkdtemp(join(tmpdir(), "dim-ci-trusted-job-"));
    const startedAt = new Date().toISOString();
    let observed: Awaited<ReturnType<typeof runCommand>>;
    try {
      expect(claim.grant.descriptor.script.path).toBe(".dim/ci/jobs/source.bash");
      const script = (await runGit("/usr/bin/git", ["-C", f.native.clone, "show", `${claim.grant.event.candidateCommit}:${claim.grant.descriptor.script.path}`])).stdout;
      expect(`sha256:${createHash("sha256").update(script).digest("hex")}`).toBe(claim.grant.descriptor.script.sha256);
      const path = join(root, "source.bash"); await writeFile(path, script, { mode: 0o700 });
      observed = await runCommand("bash", ["--noprofile", "--norc", path], { cwd: root, timeoutMs: 5000, acceptFailure: true });
    } finally { await rm(root, { recursive: true, force: true }); }
    const metadata = (value: string) => ({ bytes: String(Buffer.byteLength(value)), sha256: `sha256:${createHash("sha256").update(value).digest("hex")}`, truncated: false });
    await f.worker.report(claim, { ...result(claim.grant), startedAt, finishedAt: new Date().toISOString(),
      result: observed.exitCode === 0 ? "success" : "failure", completion: { kind: "exited", exitCode: observed.exitCode },
      stdout: metadata(observed.stdout), stderr: metadata(observed.stderr), logs: {
        stdout: { base64: Buffer.from(observed.stdout).toString("base64"), truncated: false }, stderr: { base64: Buffer.from(observed.stderr).toString("base64"), truncated: false },
      } });
    await f.accepted(claim.id); expect(observed.stdout.trim()).toBe("source");
    return claim;
  }
  try {
    await completeFixtureJob();
    const candidateRef = "refs/heads/workspace-ci";
    await runGit("/usr/bin/git", ["-C", f.native.clone, "push", "origin", `HEAD:${candidateRef}`]);
    const leaseResponse = await fetch(`${f.native.service.origin}/v1/projects/project-a/repositories/root/workspace-write-leases`, { method: "POST",
      headers: { authorization: workspaceWriteIssuerAuthorization, "content-type": "application/json" }, body: JSON.stringify({ schemaVersion: 1, generationId, repositoryId: "root", workspaceId: reviewWorkspaceId }) });
    const lease: unknown = await leaseResponse.json();
    if (!lease || typeof lease !== "object" || !("username" in lease) || typeof lease.username !== "string" || !("password" in lease) || typeof lease.password !== "string") throw new Error("fixture lease missing");
    const headers = { authorization: `Basic ${Buffer.from(`${lease.username}:${lease.password}`).toString("base64")}`, "content-type": "application/json" };
    const body = { schemaVersion: 1, requestId: randomUUID(), candidateRef,
      candidateCommit: (await runGit("/usr/bin/git", ["-C", f.native.clone, "rev-parse", "HEAD"])).stdout.trim(),
      candidateTree: (await runGit("/usr/bin/git", ["-C", f.native.clone, "rev-parse", "HEAD^{tree}"])).stdout.trim() };
    const endpoint = `${f.native.service.origin}/v1/projects/project-a/repositories/root/workspace-ci/requests`;
    const requested = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(body) }); expect(requested.status).toBe(200);
    const receipt: unknown = await requested.json();
    if (!receipt || typeof receipt !== "object" || !("reviewId" in receipt) || typeof receipt.reviewId !== "string") throw new Error("fixture request missing");
    const reviewId = receipt.reviewId;
    await expect.poll(() => f.ci.store.list().filter((job) => "reviewId" in job.event && job.event.reviewId === reviewId).length, { timeout: 10_000 }).toBe(1);
    const repeated = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(body) }); expect(repeated.status).toBe(200); await repeated.body?.cancel();
    const claim = await completeFixtureJob(); expect(claim.grant.event.reviewId).toBe(reviewId);
    expect(f.ci.store.list().filter((job) => "reviewId" in job.event && job.event.reviewId === reviewId)).toHaveLength(1);
    const status = await fetch(`${endpoint}/${body.requestId}`, { headers }); expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ status: { state: "succeeded", jobs: [{ name: "source", status: "succeeded", executionId: claim.id }] } });
    const denied = await fetch(`${f.native.service.origin}/v1/projects/project-a/repositories/root/reviews/${reviewId}/promotions`, { method: "POST", headers, body: '{"schemaVersion":1}' });
    expect([401, 403]).toContain(denied.status); await denied.body?.cancel();
  } finally { await f.close(); }
}, 45_000);
