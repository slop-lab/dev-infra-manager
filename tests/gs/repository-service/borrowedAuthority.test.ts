import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import {
  openRepositoryAuthority,
  selectedRefUpdatePolicyRevision,
  type BorrowedRepositoryMutationAuthority,
} from "../../../packages/gs/repository-service/src/index.js";
import { allowAllRefUpdatePolicies, authorityFixture, cleanupAuthorityFixtures } from "./fixture.js";

afterEach(cleanupAuthorityFixtures);

it("completes feature-style nested promotion through a revocable already-exclusive authority", async () => {
  const fixture = await authorityFixture();
  const refUpdatePolicies = allowAllRefUpdatePolicies();
  const authority = await openRepositoryAuthority({
    statePath: fixture.statePath,
    runtime: fixture.runtime,
    gitIdentity: fixture.gitIdentity,
    refUpdatePolicies,
  });
  let escaped: BorrowedRepositoryMutationAuthority | undefined;
  try {
    await authority.registerRepository({
      selector: fixture.selector,
      ownerPrincipalId: "host.example-1",
      policy: fixture.policy,
      branches: [{ protectedRef: "refs/heads/main", ...fixture.initial }],
    });

    const receipt = await bounded(authority.mutate(fixture.selector, async ({ authority: borrowed, target }) => {
      escaped = borrowed;
      const resolved = await borrowed.resolve(fixture.selector);
      expect(resolved).toEqual(target);
      await borrowed.assertCurrent(resolved);
      return borrowed.promote(fixture.change);
    }));

    expect(receipt).toEqual({ outcome: "promoted", sequence: 1 });
    expect((await authority.resolve(fixture.selector)).ownerPrincipalId).toBe("host.example-1");
    const database = new DatabaseSync(fixture.statePath, { readOnly: true });
    try {
      const row = database.prepare("SELECT record_json FROM repository_ref_transition").get();
      if (!isRecord(row) || typeof row.record_json !== "string") throw new Error("repository transition is missing");
      const record: unknown = JSON.parse(row.record_json);
      if (!isRecord(record)) throw new Error("repository transition record is invalid");
      expect(record.refPolicyRevision).toBe(selectedRefUpdatePolicyRevision(refUpdatePolicies));
    } finally {
      database.close();
    }
    if (escaped === undefined) throw new Error("borrowed authority was not issued");
    await expect(escaped.resolve(fixture.selector)).rejects.toThrow(/expired/i);
  } finally {
    await authority.close();
  }
});

async function bounded<Result>(operation: Promise<Result>): Promise<Result> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("nested repository authority operation timed out")), 2_000);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
