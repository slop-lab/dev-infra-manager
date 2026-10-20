import { writeFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { basic, fixture, generationId, git, record, reviewer, text } from "./optionalFeaturesFixture.js";

it("repository-only service imports and pushes proposals without review, workflow or CI services while denying protected writes", async () => {
  const f = await fixture(false);
  try {
    await writeFile(join(f.source, "README.md"), "proposal\n"); await f.commit();
    await git("/usr/bin/git", ["-C", f.source, "push", "origin", `HEAD:${f.proposalRef}`]);
    await expect(git("/usr/bin/git", ["-C", f.source, "push", "origin", "HEAD:refs/heads/main"])).rejects.toThrow();
    expect((await git("/usr/bin/git", ["--git-dir", join(f.root, "state/project/main.git"), "rev-parse", "refs/heads/main"])).stdout.trim()).toBe(f.initial);
    expect(await readdir(join(f.root, "state/project/main.git"))).not.toContain("dim-authoritative-reviews");
    const absent = await fetch(`${f.origin}/v1/projects/project/repositories/main/reviews`, { headers: { authorization: basic(reviewer) } });
    expect(absent.status).toBe(404);
  } finally { await f.service.close(); await rm(f.root, { recursive: true, force: true }); }
}, 20_000);

it("review-only service records and approves real Git proposals without reading workflow files or requiring CI", async () => {
  const f = await fixture(true);
  try {
    await writeFile(join(f.source, "README.md"), "human-reviewed proposal\n"); await f.commit();
    await git("/usr/bin/git", ["-C", f.source, "push", "origin", `HEAD:${f.proposalRef}`]);
    const resolved = await fetch(`${f.origin}/v1/projects/project/repositories/main/reviews/resolve`, { method: "POST", headers: { authorization: basic(reviewer), "x-dim-generation-id": generationId, "content-type": "application/json" }, body: JSON.stringify({ schemaVersion: 1, proposalRef: f.proposalRef }) });
    expect(resolved.status, await resolved.clone().text()).toBe(200);
    const result = record(await resolved.json());
    const envelope = result;
    const reviewId = text(record(envelope.review), "reviewId");
    expect(envelope.attachments).toEqual([]);
    const approved = await fetch(`${f.origin}/v1/projects/project/repositories/main/reviews/${reviewId}/approvals`, { method: "POST", headers: { authorization: basic(reviewer), "x-dim-generation-id": generationId, "content-type": "application/json" }, body: JSON.stringify({ requestId: "a5d0179a-3e8e-4d2c-a246-4230ba0b7c71" }) });
    expect(approved.status, await approved.clone().text()).toBe(201);
  } finally { await f.service.close(); await rm(f.root, { recursive: true, force: true }); }
}, 20_000);
