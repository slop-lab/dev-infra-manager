import { execFile } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { repositoryPolicyRevision, type RepositoryPolicy } from "../../../packages/gs/repository-contracts/src/index.js";
import {
  openRepositoryAuthority,
  repositoryPolicyDigest,
} from "../../../packages/gs/repository-service/src/index.js";
import {
  allowAllRefUpdatePolicies,
  authorityFixture,
  cleanupAuthorityFixtures,
} from "./fixture.js";

const execute = promisify(execFile);
afterEach(cleanupAuthorityFixtures);

it("rejects orphaned rows created with foreign key enforcement disabled", async () => {
  const fixture = await registeredFixture();
  const database = new DatabaseSync(fixture.statePath);
  try {
    database.exec("PRAGMA foreign_keys=OFF");
    database.prepare("INSERT INTO repository_branch_baseline VALUES('orphan','missing','refs/heads/main',0,?,?)")
      .run(fixture.initial.commit, fixture.initial.tree);
  } finally {
    database.close();
  }

  await expect(openRepositoryAuthority(options(fixture))).rejects.toThrow(/foreign key|orphan/i);
});

it("rejects a policy update whose managed branches are a strict subset of durable baselines", async () => {
  const fixture = await authorityFixture();
  await execute("/usr/bin/git", ["--git-dir", fixture.repository, "update-ref", "refs/heads/development", fixture.initial.commit]);
  const initialPolicy = branchPolicy(["refs/heads/main", "refs/heads/development"]);
  const authority = await openRepositoryAuthority(options(fixture));
  const target = await authority.registerRepository({
    selector: fixture.selector,
    ownerPrincipalId: "repository-owner",
    policy: initialPolicy,
    branches: [
      { protectedRef: "refs/heads/main", ...fixture.initial },
      { protectedRef: "refs/heads/development", ...fixture.initial },
    ],
  });
  await authority.close();
  const reducedPolicy = branchPolicy(["refs/heads/main"]);
  const database = new DatabaseSync(fixture.statePath);
  try {
    database.prepare("INSERT INTO repository_policy_update VALUES('tenant','main',1,0,?,?,?,?)")
      .run(target.head.commit, target.policyDigest, repositoryPolicyDigest(reducedPolicy), JSON.stringify(reducedPolicy));
  } finally {
    database.close();
  }

  await expect(openRepositoryAuthority(options(fixture))).rejects.toThrow(/policy update chain|branch/i);
});

it("rejects service metadata that references an unknown authority epoch", async () => {
  const fixture = await registeredFixture();
  const database = new DatabaseSync(fixture.statePath);
  try {
    database.prepare("UPDATE service_metadata SET current_authority_epoch=? WHERE singleton=1").run("f".repeat(64));
  } finally {
    database.close();
  }

  await expect(openRepositoryAuthority(options(fixture))).rejects.toThrow(/metadata|authority epoch/i);
});

it("fences direct external SQLite edits while the authority owns live state", async () => {
  const fixture = await authorityFixture();
  const authority = await openRepositoryAuthority(options(fixture));
  await authority.registerRepository({
    selector: fixture.selector,
    ownerPrincipalId: "repository-owner",
    policy: fixture.policy,
    branches: [{ protectedRef: "refs/heads/main", ...fixture.initial }],
  });
  const database = new DatabaseSync(fixture.statePath);
  try {
    database.exec("PRAGMA foreign_keys=OFF");
    database.prepare("INSERT INTO repository_branch_baseline VALUES('external','missing','refs/heads/main',0,?,?)")
      .run(fixture.initial.commit, fixture.initial.tree);
  } finally {
    database.close();
  }

  try {
    await expect(authority.listSelectors()).rejects.toThrow(/external|changed outside/i);
  } finally {
    await authority.close();
  }
});

async function registeredFixture(): Promise<Awaited<ReturnType<typeof authorityFixture>>> {
  const fixture = await authorityFixture();
  const authority = await openRepositoryAuthority(options(fixture));
  await authority.registerRepository({
    selector: fixture.selector,
    ownerPrincipalId: "repository-owner",
    policy: fixture.policy,
    branches: [{ protectedRef: "refs/heads/main", ...fixture.initial }],
  });
  await authority.close();
  return fixture;
}

function options(fixture: Awaited<ReturnType<typeof authorityFixture>>) {
  return {
    statePath: fixture.statePath,
    runtime: fixture.runtime,
    gitIdentity: fixture.gitIdentity,
    refUpdatePolicies: allowAllRefUpdatePolicies(),
  };
}

function branchPolicy(refs: readonly string[]): RepositoryPolicy {
  const branches = Object.fromEntries(refs.map((ref) => [ref, { review: false }]));
  const revisionInput = {
    protectedRef: "refs/heads/main",
    defaultRef: "refs/heads/main",
    branches,
    extensions: {},
  };
  return {
    schemaVersion: 1 as const,
    protectedRef: "refs/heads/main",
    policyRevision: repositoryPolicyRevision(revisionInput),
    defaultRef: "refs/heads/main",
    branches,
    extensions: {},
  };
}
