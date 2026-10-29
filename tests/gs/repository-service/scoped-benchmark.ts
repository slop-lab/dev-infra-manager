import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import type { ProtectedRefFinalizedQuery, ProtectedRefIntent } from "../../../packages/gs/repository/src/index.js";
import { transitionId } from "../../../packages/gs/repository-service/src/transition-store.js";
import { openRepositoryAuthority, type RepositoryTarget } from "../../../packages/gs/repository-service/src/index.js";
import {
  addAuthorityRepository,
  allowAllRefUpdatePolicies,
  authorityFixture,
  cleanupAuthorityFixtures,
} from "./fixture.js";

export type ScopedBenchmarkResult = {
  readonly unrelatedHistory: number;
  readonly selectedHistory: number;
  readonly selectorIterations: number;
  readonly resolveIterations: number;
  readonly lookupIterations: number;
  readonly startupMilliseconds: number;
  readonly selectorMilliseconds: number;
  readonly resolveMilliseconds: number;
  readonly lookupMilliseconds: number;
  readonly promotionMilliseconds: number;
  readonly queryPlans: readonly string[];
};

export async function runScopedBenchmark(unrelatedHistory: number): Promise<ScopedBenchmarkResult> {
  const fixture = await authorityFixture();
  const archive = await addAuthorityRepository(fixture, "archive");
  const options = {
    statePath: fixture.statePath,
    runtime: fixture.runtime,
    gitIdentity: fixture.gitIdentity,
    refUpdatePolicies: allowAllRefUpdatePolicies(),
  };
  const owner = await openRepositoryAuthority(options);
  await owner.registerRepository({ selector: fixture.selector, ownerPrincipalId: "repository-owner", policy: fixture.policy,
    branches: [{ protectedRef: "refs/heads/main", ...fixture.initial }] });
  const archiveTarget = await owner.registerRepository({ selector: archive, ownerPrincipalId: "repository-owner", policy: fixture.policy,
    branches: [{ protectedRef: "refs/heads/main", ...fixture.initial }] });
  await owner.close();
  insertHistory(fixture.statePath, archiveTarget, fixture.initial, unrelatedHistory);

  const startupStart = performance.now();
  const authority = await openRepositoryAuthority(options);
  const startupMilliseconds = performance.now() - startupStart;
  try {
    const target = await authority.resolve(fixture.selector);
    const query: ProtectedRefFinalizedQuery = {
      ...fixture.change,
      protectedRef: target.head.protectedRef,
      expectedTree: target.head.tree,
      incarnationId: target.incarnationId,
      authorityEpoch: target.authorityEpoch,
      policyDigest: target.policyDigest,
      ownerPrincipalId: target.ownerPrincipalId,
      refPolicyRevision: target.refPolicyRevision,
    };
    const resolveIterations = 20;
    const lookupIterations = 50;
    const selectorIterations = 100;
    const selectorStart = performance.now();
    for (let index = 0; index < selectorIterations; index += 1) await authority.listSelectors({ namespaceId: "tenant" });
    const selectorMilliseconds = performance.now() - selectorStart;
    const resolveStart = performance.now();
    for (let index = 0; index < resolveIterations; index += 1) await authority.resolve(fixture.selector);
    const resolveMilliseconds = performance.now() - resolveStart;
    const lookupStart = performance.now();
    for (let index = 0; index < lookupIterations; index += 1) await authority.findFinalized(query);
    const lookupMilliseconds = performance.now() - lookupStart;
    const promotionStart = performance.now();
    await authority.promote(fixture.change);
    const promotionMilliseconds = performance.now() - promotionStart;
    const database = new DatabaseSync(fixture.statePath, { readOnly: true });
    try {
      return {
        unrelatedHistory: count(database, "tenant", "archive"),
        selectedHistory: count(database, "tenant", "main"),
        selectorIterations,
        resolveIterations,
        lookupIterations,
        startupMilliseconds,
        selectorMilliseconds,
        resolveMilliseconds,
        lookupMilliseconds,
        promotionMilliseconds,
        queryPlans: plans(database),
      };
    } finally {
      database.close();
    }
  } finally {
    await authority.close();
  }
}

function insertHistory(
  path: string,
  target: RepositoryTarget,
  initial: { readonly commit: string; readonly tree: string },
  count: number,
): void {
  const database = new DatabaseSync(path);
  try {
    database.exec("BEGIN IMMEDIATE");
    const insert = database.prepare("INSERT INTO repository_ref_transition(namespace_id,repository_id,sequence,protected_ref,authorization_id,transition_id,record_json,finalized) VALUES(?,?,?,?,?,?,?,1)");
    let expectedCommit = initial.commit;
    let expectedTree = initial.tree;
    for (let sequence = 1; sequence <= count; sequence += 1) {
      const intent = syntheticIntent(target, sequence, expectedCommit, expectedTree);
      insert.run(intent.namespaceId, intent.repositoryId, intent.sequence, intent.protectedRef,
        intent.authorizationId, transitionId(intent), JSON.stringify(intent));
      expectedCommit = intent.candidateCommit;
      expectedTree = intent.candidateTree;
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
}

function syntheticIntent(
  target: RepositoryTarget,
  sequence: number,
  expectedCommit: string,
  expectedTree: string,
): ProtectedRefIntent {
  const candidateCommit = createHash("sha1").update(`commit:${sequence}`).digest("hex");
  const candidateTree = createHash("sha1").update(`tree:${sequence}`).digest("hex");
  return {
    namespaceId: target.selector.namespaceId,
    repositoryId: target.selector.repositoryId,
    sequence,
    protectedRef: target.head.protectedRef,
    proposalRef: "refs/heads/proposals/change",
    expectedCommit,
    expectedTree,
    candidateCommit,
    candidateTree,
    authorizationId: createHash("sha256").update(`authorization:${sequence}`).digest("hex"),
    evidenceDigest: createHash("sha256").update(`evidence:${sequence}`).digest("hex"),
    incarnationId: target.incarnationId,
    authorityEpoch: target.authorityEpoch,
    policyDigest: target.policyDigest,
    ownerPrincipalId: target.ownerPrincipalId,
    refPolicyRevision: target.refPolicyRevision,
  };
}

function count(database: DatabaseSync, namespaceId: string, repositoryId: string): number {
  const row = database.prepare("SELECT count(*) AS count FROM repository_ref_transition WHERE namespace_id=? AND repository_id=?")
    .get(namespaceId, repositoryId);
  if (!isRecord(row) || typeof row.count !== "number") throw new Error("benchmark transition count is invalid");
  return row.count;
}

function plans(database: DatabaseSync): readonly string[] {
  const statements = [
    "SELECT * FROM repository_ref_transition WHERE namespace_id='tenant' AND repository_id='main' ORDER BY sequence DESC LIMIT 1",
    "SELECT * FROM repository_ref_transition WHERE namespace_id='tenant' AND repository_id='main' AND protected_ref='refs/heads/main' AND finalized=1 ORDER BY sequence DESC LIMIT 1",
    "SELECT * FROM repository_ref_transition WHERE namespace_id='tenant' AND repository_id='main' AND authorization_id='x' AND protected_ref='refs/heads/main' AND finalized=1 ORDER BY sequence",
  ];
  return statements.flatMap((statement) => database.prepare(`EXPLAIN QUERY PLAN ${statement}`).all().map((row) => {
    if (!isRecord(row) || typeof row.detail !== "string") throw new Error("benchmark query plan is invalid");
    return row.detail;
  }));
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(JSON.stringify(await runScopedBenchmark(10_000)));
  } finally {
    await cleanupAuthorityFixtures();
  }
}
