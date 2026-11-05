import { Command } from "commander";
import { writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, type MockInstance, vi } from "vitest";
import { parsePullRequest, parsePullRequestList, currentRevision } from "@slop-lab/gs-pull-requests";
import { runNativeGitCli, registerProjectCommands } from "../../../../packages/host/plugins/native-git/src/cli/index.js";
import { managedProjectFixture } from "./nativeProjectIntegrationFixture.js";
import { cleanupFinalizeFixtures, generationId, humanReviewer, hostPromoter, humanReviewerAuthorization, workspaceWriteIssuerAuthorization, runGit } from "../../../control-plane/plugins/git-repositories/nativeRootImportFinalizeFixture.js";
import { record, text } from "../../../control-plane/plugins/git-repositories/optionalFeaturesFixture.js";
it("discovers human PR commands and their inputs through host plugin help", () => {
  const program = new Command().name("dim"); registerProjectCommands(program);
  const project = program.commands.find((command) => command.name() === "project")!;
  const pr = project.commands.find((command) => command.name() === "pull-request")!;
  expect(pr.aliases()).toContain("pr");
  for (const command of ["list", "create", "show", "refresh", "edit", "close", "reopen", "comment", "review", "approve", "revoke", "merge", "diff", "blame"]) expect(pr.helpInformation()).toContain(command);
  expect(pr.commands.find((command) => command.name() === "create")?.helpInformation()).toContain("--source");
  expect(pr.commands.find((command) => command.name() === "comment")?.helpInformation()).toContain("--revision");
});

describe.sequential("ergonomic CLI PR actions against the actual service", () => {
  let fixtureRoot: string | undefined;
  let serviceOrigin = "";
  let serviceRoot = "";
  let output: MockInstance;
  let call: (...args: string[]) => Promise<unknown>;
  let pr: ReturnType<typeof parsePullRequest>;
  let reviewId = "";

  beforeAll(async () => {
    const fixture = await managedProjectFixture(); fixtureRoot = fixture.root; serviceOrigin = fixture.service.origin; serviceRoot = fixture.serviceRoot;
    const imported = await fixture.importRepository("public");
    await writeFile(join(fixture.root, "reviewer.json"), JSON.stringify({ schemaVersion: 1, serviceId: "native-main", baseUrl: fixture.service.origin, generationId, ...humanReviewer }), { mode: 0o600 });
    await writeFile(join(fixture.root, "promoter.json"), JSON.stringify({ schemaVersion: 1, serviceId: "native-main", endpoint: fixture.service.origin, generationId,
      role: "host-promoter", hostId: hostPromoter.hostId, credential: { username: hostPromoter.username, password: hostPromoter.password } }), { mode: 0o600 });
    const workspaceId = Buffer.alloc(32, 83).toString("base64url");
    const leased = await fetch(`${fixture.service.origin}/v1/projects/project-a/repositories/public/workspace-write-leases`, { method: "POST", headers: { authorization: workspaceWriteIssuerAuthorization, "content-type": "application/json" }, body: JSON.stringify({ schemaVersion: 1, generationId, repositoryId: "public", workspaceId }) });
    expect(leased.status).toBe(201); const lease = record(await leased.json());
    const remote = new URL("/v1/projects/project-a/repositories/public.git", fixture.service.origin); remote.username = text(lease, "username"); remote.password = text(lease, "password");
    await writeFile(join(imported.sourceRepository, "README.md"), "CLI candidate\n");
    await runGit("/usr/bin/git", ["-C", imported.sourceRepository, "-c", "user.name=CLI Test", "-c", "user.email=cli@example.invalid", "commit", "-am", "candidate"]);
    await runGit("/usr/bin/git", ["-C", imported.sourceRepository, "remote", "add", "origin", remote.toString()]);
    await runGit("/usr/bin/git", ["-C", imported.sourceRepository, "push", "origin", "HEAD:refs/heads/cli-change"]);
    vi.stubEnv("DIM_MANAGED_STATE_ROOT", fixture.state); vi.stubEnv("DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE", fixture.hostFile);
    output = vi.spyOn(console, "log").mockImplementation(() => {});
    call = async (...args: string[]): Promise<unknown> => { output.mockClear(); await runNativeGitCli(["project", "pr", ...args, "--json"]); return JSON.parse(String(output.mock.calls.at(-1)?.[0])) as unknown; };
  }, 30_000);

  afterAll(async () => {
    vi.restoreAllMocks(); vi.unstubAllEnvs(); await cleanupFinalizeFixtures();
    if (fixtureRoot !== undefined) await rm(fixtureRoot, { recursive: true, force: true });
  });

  it("creates, edits, comments, closes and reopens a pull request", async () => {
    pr = parsePullRequest(await call("create", "acme", "public", "--title", "CLI pull request", "--source", "cli-change"));
    expect(pr.targetRef).toBe("refs/heads/main"); expect(parsePullRequestList(await call("ls", "acme", "public"))[0]?.id).toBe(pr.id);
    pr = parsePullRequest(await call("edit", "acme", "public", pr.id, "--title", "Edited title")); expect(pr.version).toBe(2);
    await expect(call("edit", "acme", "public", pr.id, "--title", "Stale write", "--expected-version", "1")).rejects.toThrow();
    pr = parsePullRequest(await call("comment", "acme", "public", pr.id, "--body", "Explain line", "--path", "README.md", "--side", "head", "--line", "1"));
    expect(pr.comments[0]?.revisionId).toBe(currentRevision(pr).id); expect(pr.comments[0]?.actorId).toBe("owner");
    pr = parsePullRequest(await call("close", "acme", "public", pr.id)); expect(pr.state).toBe("closed");
    await expect(call("review", "acme", "public", pr.id)).rejects.toThrow();
    pr = parsePullRequest(await call("reopen", "acme", "public", pr.id)); expect(pr.state).toBe("open");
  });

  it("reviews and inspects the exact pull request revision", async () => {
    const review = record(await call("review", "acme", "public", pr.id)); reviewId = text(record(record(review.review).review), "reviewId");
    expect(review.revisionId).toBe(currentRevision(pr).id);
    const inspected = await fetch(`${serviceOrigin}/v1/projects/project-a/repositories/public/reviews/${reviewId}`, { headers: { authorization: humanReviewerAuthorization, "x-dim-generation-id": generationId } });
    expect(inspected.status).toBe(200); expect(record(await inspected.json()).approvals).toEqual([]);
    output.mockClear();
    await runNativeGitCli(["project", "review", "inspect", "acme", "public", reviewId, "--json"]);
    expect(JSON.parse(String(output.mock.calls.at(-1)?.[0]))).toMatchObject({ reviewId, ci: { state: "not-required" } });
    output.mockClear();
    await runNativeGitCli(["project", "diff", "acme", "public", "--base", currentRevision(pr).targetCommit, "--head", currentRevision(pr).sourceCommit, "--json"]);
    expect(JSON.parse(String(output.mock.calls.at(-1)?.[0]))).toMatchObject({ baseCommit: currentRevision(pr).targetCommit, headCommit: currentRevision(pr).sourceCommit });
    expect(parsePullRequest(await call("refresh", "acme", "public", pr.id)).id).toBe(pr.id);
    await expect(call("show", "acme", "private", pr.id)).rejects.toThrow(/no ready repository/);
    expect(await call("diff", "acme", "public", pr.id)).toMatchObject({ baseCommit: currentRevision(pr).targetCommit, headCommit: currentRevision(pr).sourceCommit });
    expect(await call("blame", "acme", "public", pr.id, "--path", "README.md", "--side", "head", "--line", "1")).toMatchObject({ author: "CLI Test", summary: "candidate" });
  });

  it("rejects merge without a current approval and honors revocation", async () => {
    await expect(call("merge", "acme", "public", pr.id)).rejects.toThrow();
    expect(await call("approve", "acme", "public", pr.id)).toMatchObject({ status: "approved", ci: { state: "not-required" } });
    expect(await call("revoke", "acme", "public", pr.id)).toMatchObject({ status: "revoked" });
    await expect(call("merge", "acme", "public", pr.id)).rejects.toThrow();
  });

  it("merges the exact reviewed revision after a fresh approval", async () => {
    await call("approve", "acme", "public", pr.id);
    expect(await call("merge", "acme", "public", pr.id)).toMatchObject({ pullRequest: { state: "merged" }, refreshPending: false });
    expect((await runGit("/usr/bin/git", ["--git-dir", join(serviceRoot, "project-a/public.git"), "rev-parse", "refs/heads/main"])).stdout.trim()).toBe(currentRevision(pr).sourceCommit);
  });
});
