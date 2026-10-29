import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { createInterface } from "node:readline";
import { afterEach, expect, it } from "vitest";
import { repositoryPolicyRevision } from "../../../packages/gs/repository-contracts/src/index.js";
import { openRepositoryAuthority } from "../../../packages/gs/repository-service/src/index.js";
import { allowAllRefUpdatePolicies, authorityFixture, cleanupAuthorityFixtures, ref } from "./fixture.js";

afterEach(cleanupAuthorityFixtures);

const refUpdatePolicies = allowAllRefUpdatePolicies();
const reviewPolicyOwners = [{ sectionName: "review", enforcement: "configuration" as const, parse: (value: unknown) => value }];

it("registers, promotes, retries, fences stale policy, and preserves incarnation across restart", async () => {
  const fixture = await authorityFixture();
  const authority = await openRepositoryAuthority({
    statePath: fixture.statePath,
    runtime: fixture.runtime,
    gitIdentity: fixture.gitIdentity,
    refUpdatePolicies,
    policySectionOwners: reviewPolicyOwners,
  });
  await authority.registerRepository({
    selector: fixture.selector,
    ownerPrincipalId: "repository-owner",
    policy: fixture.policy,
    branches: [{ protectedRef: "refs/heads/main", ...fixture.initial }],
  });
  const initialTarget = await authority.resolve(fixture.selector);
  expect(await authority.promote(fixture.change)).toEqual({ outcome: "promoted", sequence: 1 });
  expect(await authority.promote(fixture.change)).toEqual({ outcome: "already-current", sequence: 1 });
  expect(await ref(fixture.repository, "refs/heads/main")).toBe(fixture.change.candidateCommit);

  const changedPolicyBase = {
    schemaVersion: 1 as const,
    protectedRef: "refs/heads/main",
    extensions: { review: { required: true } },
  };
  const changedPolicy = { ...changedPolicyBase, policyRevision: repositoryPolicyRevision(changedPolicyBase) };
  await authority.replacePolicy({
    selector: fixture.selector,
    expectedPolicyDigest: initialTarget.policyDigest,
    expectedProtectedHead: fixture.change.candidateCommit,
    policy: changedPolicy,
  });
  await expect(authority.assertCurrent(initialTarget)).rejects.toThrow(/policy/i);
  await expect(openRepositoryAuthority({
    statePath: fixture.statePath,
    runtime: fixture.runtime,
    gitIdentity: fixture.gitIdentity,
    refUpdatePolicies,
    policySectionOwners: reviewPolicyOwners,
  })).rejects.toThrow(/active owner/i);
  await authority.close();

  const restarted = await openRepositoryAuthority({
    statePath: fixture.statePath,
    runtime: fixture.runtime,
    gitIdentity: fixture.gitIdentity,
    refUpdatePolicies,
    policySectionOwners: reviewPolicyOwners,
  });
  try {
    const current = await restarted.resolve(fixture.selector);
    expect(current.incarnationId).toBe(initialTarget.incarnationId);
    expect(current.authorityEpoch).not.toBe(initialTarget.authorityEpoch);
    expect(await restarted.list({ namespaceId: "tenant" })).toHaveLength(1);
    expect(await restarted.availability(fixture.selector)).toEqual({ kind: "available", target: current });
    await expect(restarted.assertCurrent({ ...current, incarnationId: "00000000-0000-4000-8000-000000000000" }))
      .rejects.toThrow(/incarnation/i);
  } finally {
    await restarted.close();
  }
});

it.each(["before", "after"] as const)("recovers without replay after a crash %s Git CAS", async (mode) => {
  const fixture = await authorityFixture({ wrappedGit: true });
  const authority = await openRepositoryAuthority({
    statePath: fixture.statePath,
    runtime: fixture.runtime,
    gitIdentity: fixture.gitIdentity,
    refUpdatePolicies,
  });
  await authority.registerRepository({
    selector: fixture.selector,
    ownerPrincipalId: "repository-owner",
    policy: fixture.policy,
    branches: [{ protectedRef: "refs/heads/main", ...fixture.initial }],
  });
  await fixture.setGitMode(mode);
  await expect(authority.promote(fixture.change)).rejects.toThrow(/recovery is required/i);
  expect(await authority.availability(fixture.selector)).toEqual({ kind: "recovery-required" });
  await authority.close();
  await fixture.setGitMode("pass");

  const recovered = await openRepositoryAuthority({
    statePath: fixture.statePath,
    runtime: fixture.runtime,
    gitIdentity: fixture.gitIdentity,
    refUpdatePolicies: allowAllRefUpdatePolicies("e".repeat(64)),
  });
  try {
    const head = await ref(fixture.repository, "refs/heads/main");
    expect(head).toBe(mode === "before" ? fixture.change.expectedCommit : fixture.change.candidateCommit);
    expect(await recovered.promote(fixture.change)).toEqual(mode === "before"
      ? { outcome: "promoted", sequence: 1 }
      : { outcome: "already-current", sequence: 1 });
  } finally {
    await recovered.close();
  }
});

it("rejects a corrupt journal without resetting owned state", async () => {
  const fixture = await authorityFixture();
  const authority = await openRepositoryAuthority({
    statePath: fixture.statePath,
    runtime: fixture.runtime,
    gitIdentity: fixture.gitIdentity,
    refUpdatePolicies,
  });
  await authority.registerRepository({
    selector: fixture.selector,
    ownerPrincipalId: "repository-owner",
    policy: fixture.policy,
    branches: [{ protectedRef: "refs/heads/main", ...fixture.initial }],
  });
  await authority.promote(fixture.change);
  await authority.close();
  const database = new DatabaseSync(fixture.statePath);
  try {
    database.prepare("UPDATE repository_ref_transition SET record_json='{}'").run();
  } finally {
    database.close();
  }

  await expect(openRepositoryAuthority({
    statePath: fixture.statePath,
    runtime: fixture.runtime,
    gitIdentity: fixture.gitIdentity,
    refUpdatePolicies,
  })).rejects.toThrow(/journal|transition/i);
  const inspection = new DatabaseSync(fixture.statePath, { readOnly: true });
  try {
    expect(inspection.prepare("SELECT count(*) AS count FROM repository_ref_transition").get()).toEqual({ count: 1 });
  } finally {
    inspection.close();
  }
});

it("uses a cross-process SQLite owner boundary and rejects missing owned storage", async () => {
  const fixture = await authorityFixture();
  const authority = await openRepositoryAuthority({
    statePath: fixture.statePath,
    runtime: fixture.runtime,
    gitIdentity: fixture.gitIdentity,
    refUpdatePolicies,
  });
  await authority.registerRepository({
    selector: fixture.selector,
    ownerPrincipalId: "repository-owner",
    policy: fixture.policy,
    branches: [{ protectedRef: "refs/heads/main", ...fixture.initial }],
  });
  await authority.close();
  const driver = new URL("./owner-driver.ts", import.meta.url).pathname;
  const child = spawn(process.execPath, ["--conditions=source", "--import", "tsx", driver,
    fixture.statePath, fixture.runtime.storageRoot, fixture.runtime.gitExecutable, fixture.runtime.gitVersion], {
    cwd: new URL("../..", import.meta.url).pathname,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let ownerStderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { ownerStderr = `${ownerStderr}${chunk}`.slice(-4096); });
  const lines = createInterface({ input: child.stdout });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("owner driver did not become ready")), 10_000);
    lines.once("line", (line) => {
      clearTimeout(timeout);
      if (line === "READY") resolve(); else reject(new Error(`unexpected owner driver output: ${line}`));
    });
    child.once("exit", (code) => reject(new Error(`owner driver exited early with ${String(code)}: ${ownerStderr}`)));
  });
  await expect(openRepositoryAuthority({
    statePath: fixture.statePath,
    runtime: fixture.runtime,
    gitIdentity: fixture.gitIdentity,
    refUpdatePolicies,
  })).rejects.toThrow(/active owner/i);
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  lines.close();
  await rm(fixture.statePath);
  await expect(openRepositoryAuthority({
    statePath: fixture.statePath,
    runtime: fixture.runtime,
    gitIdentity: fixture.gitIdentity,
    refUpdatePolicies,
  })).rejects.toThrow(/owned repository state is missing/i);
});
