import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { openRepositoryAuthority } from "../../../packages/gs/repository-service/src/index.js";
import {
  allowAllRefUpdatePolicies,
  authorityFixture,
  cleanupAuthorityFixtures,
} from "./fixture.js";

afterEach(cleanupAuthorityFixtures);

it("rejects schema version 2 state with a missing required transition index", async () => {
  const fixture = await registeredFixture();
  const database = new DatabaseSync(fixture.statePath);
  try {
    database.exec("DROP INDEX repository_ref_transition_authorization");
  } finally {
    database.close();
  }

  await expectSchemaRejected(fixture);
});

it.each([
  ["non-STRICT table", transitionTable("finalized INTEGER NOT NULL CHECK(finalized IN(0,1))", false, true)],
  ["missing finalized check", transitionTable("finalized INTEGER NOT NULL", true, true)],
  ["missing authorization column", transitionTable("finalized INTEGER NOT NULL CHECK(finalized IN(0,1))", true, false)],
  ["missing foreign key", transitionTable("finalized INTEGER NOT NULL CHECK(finalized IN(0,1))", true, true)
    .replace(",\n    FOREIGN KEY(namespace_id,repository_id) REFERENCES repository_catalog(namespace_id,repository_id)", "")],
  ["altered primary key", transitionTable("finalized INTEGER NOT NULL CHECK(finalized IN(0,1))", true, true)
    .replace("PRIMARY KEY(namespace_id,repository_id,sequence)", "PRIMARY KEY(transition_id)")],
] as const)("rejects schema version 2 state with %s", async (_case, sql) => {
  const fixture = await registeredFixture();
  recreateTransitionTable(fixture.statePath, sql);

  await expectSchemaRejected(fixture);
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

async function expectSchemaRejected(fixture: Awaited<ReturnType<typeof authorityFixture>>): Promise<void> {
  const error: unknown = await openRepositoryAuthority(options(fixture)).then(async (authority) => {
    await authority.close();
    return undefined;
  }, (reason: unknown) => reason);
  expect(error).toBeInstanceOf(Error);
  if (error instanceof Error) expect(error.message).toMatch(/schema/i);
}

function recreateTransitionTable(path: string, sql: string): void {
  const database = new DatabaseSync(path);
  try {
    database.exec("PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE");
    for (const name of ["repository_ref_transition_branch", "repository_ref_transition_authorization", "repository_ref_transition_pending"]) {
      database.exec(`DROP INDEX ${name}`);
    }
    database.exec("ALTER TABLE repository_ref_transition RENAME TO replaced_repository_ref_transition");
    database.exec(sql);
    database.exec("DROP TABLE replaced_repository_ref_transition");
    database.exec("CREATE INDEX repository_ref_transition_branch ON repository_ref_transition(namespace_id,repository_id,protected_ref,finalized,sequence DESC)");
    if (sql.includes("authorization_id")) {
      database.exec("CREATE INDEX repository_ref_transition_authorization ON repository_ref_transition(namespace_id,repository_id,authorization_id,protected_ref,finalized,sequence)");
    }
    database.exec("CREATE INDEX repository_ref_transition_pending ON repository_ref_transition(finalized,namespace_id,repository_id,sequence); COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
}

function transitionTable(finalizedColumn: string, strict: boolean, authorizationColumn: boolean): string {
  return `CREATE TABLE repository_ref_transition(
    namespace_id TEXT NOT NULL,
    repository_id TEXT NOT NULL,
    sequence INTEGER NOT NULL CHECK(sequence>0),
    protected_ref TEXT NOT NULL,
    ${authorizationColumn ? "authorization_id TEXT NOT NULL," : ""}
    transition_id TEXT NOT NULL UNIQUE,
    record_json TEXT NOT NULL,
    ${finalizedColumn},
    PRIMARY KEY(namespace_id,repository_id,sequence),
    FOREIGN KEY(namespace_id,repository_id) REFERENCES repository_catalog(namespace_id,repository_id)
  )${strict ? " STRICT" : ""}`;
}
