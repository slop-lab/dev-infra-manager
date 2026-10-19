import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it } from "vitest";
import { StaleExecutionSourceError } from "../../../packages/control-plane/plugins/ci/src/source.js";
import { runGit } from "../../control-plane/plugins/native-git/nativeRootImportFinalizeFixture.js";
import { installedExecutionFixture, type InstalledExecutionFixture } from "./installedExecutionFixture.js";
import { result } from "../../contracts/ci/executionFixture.js";

let fixture: InstalledExecutionFixture | undefined;
beforeEach(async () => { fixture = await installedExecutionFixture(); }, 30_000);
afterEach(async () => { try { await fixture?.close(); } finally { fixture = undefined; } });
function current() { if (!fixture) throw new Error("installed execution fixture setup did not complete"); return fixture; }

it("replays claims and cleaned results while keeping raw diagnostics out of job summaries", async () => {
  const f = current(), request = randomUUID();
  f.setPublicationAvailable(true);
  const [claim, replay] = await Promise.all([f.worker.claim(request), f.worker.claim(request)]);
  expect(replay).toEqual(claim); expect(await f.worker.claim(request)).toEqual(claim);
  if (!claim?.grant) throw new Error("candidate event did not produce a granted claim");
  expect(claim.grant.event.jobName).toBe("source");
  const credential = await f.worker.candidate(claim);
  const remote = new URL("/v1/projects/project-a/repositories/root.git", f.native.service.origin);
  remote.username = credential.username; remote.password = credential.password;
  expect((await runGit("/usr/bin/git", ["ls-remote", remote.href, "refs/heads/main"])).stdout)
    .toContain(claim.grant.descriptor.expectedProtectedHead);
  const diagnostic = Buffer.alloc(64 * 1024, "x"), encoded = diagnostic.toString("base64");
  const output = { bytes: String(8 * 1024 * 1024), sha256: `sha256:${"a".repeat(64)}`, truncated: false };
  const evidence = { ...result(claim.grant), stdout: output, stderr: output,
    logs: { stdout: { base64: encoded, truncated: true }, stderr: { base64: encoded, truncated: true } } };
  await f.worker.report(claim, evidence); await f.worker.report(claim, evidence);
  expect(f.ci.store.get(claim.id).phase).toBe("finished");
  expect((await f.worker.claim(request))?.result?.logs.stdout.base64).toBe(encoded);
  const jobs = await f.query("/v1/jobs"), detail = await f.query(`/v1/jobs/${claim.id}`);
  expect(jobs.status).toBe(200); expect(detail.status).toBe(200);
  expect(JSON.stringify(await jobs.json())).not.toContain(encoded);
  expect(JSON.stringify(await detail.json())).toContain(encoded);
  await f.accepted(claim.id);
  const published = await f.storedEvidence(claim.id);
  expect(published).not.toHaveProperty("logs");
  expect(JSON.stringify(published)).not.toContain(encoded);
}, 30_000);

it("durably retains cleaned results during a Git outage and gates promotion until publication recovers", async () => {
  const f = current(), claim = await f.claim();
  await f.worker.report(claim, result(claim.grant));
  expect(f.ci.store.get(claim.id)).toMatchObject({ phase: "finished", publication: "pending" });
  expect(f.ci.store.pendingResults()).toHaveLength(1);
  await f.approve();
  expect((await f.promote()).status).toBe(409);
  f.setPublicationAvailable(true); await f.accepted(claim.id);
  expect(await f.storedEvidence(claim.id)).not.toHaveProperty("logs");
  expect((await f.promote()).status).toBe(201);
  expect(await f.protectedHead()).toBe(f.envelope.review.candidateCommit);
}, 30_000);

it("fences superseded execution evidence and promotes only after the new attempt succeeds", async () => {
  const f = current(); f.setPublicationAvailable(true);
  const first = await f.claim(), firstResult = result(first.grant);
  await f.worker.report(first, firstResult); await f.accepted(first.id); await f.approve();
  expect((await f.retry(first.id)).status).toBe(200);
  const next = await f.claim();
  expect(next.grant.attempt).toBe(first.grant.attempt + 1);
  await expect(f.source.publish(first.grant, firstResult)).rejects.toBeInstanceOf(StaleExecutionSourceError);
  expect((await f.promote()).status).toBe(409);
  await f.worker.report(next, result(next.grant)); await f.accepted(next.id);
  expect((await f.promote()).status).toBe(201);
  expect(await f.protectedHead()).toBe(f.envelope.review.candidateCommit);
}, 30_000);
