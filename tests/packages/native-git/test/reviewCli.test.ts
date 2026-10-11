import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  nativeGitReviewFixture,
  objectArrayField,
  parseJsonObject,
  stringField,
  type ReviewFixture
} from "./nativeGitReviewHarness.js";

const run = promisify(execFile);
const fixtures: ReviewFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
});

describe("DIM native Git review CLI", () => {
  it("inspects, approves, shows, and revokes one exact review through the admin API", async () => {
    // Given
    const fixture = await startFixture();

    // When
    const inspected = await cli(fixture, "reviewer-a-user", "reviewer-a-secret", [
      "inspect", "project-a", "source", "refs/heads/main", fixture.proposalRef
    ]);
    const reviewId = stringField(inspected, "reviewId");
    const first = await cli(fixture, "reviewer-a-user", "reviewer-a-secret", ["approve", "project-a", "source", reviewId]);
    const second = await cli(fixture, "docs-reviewer-user", "docs-reviewer-secret", ["approve", "project-a", "source", reviewId]);
    const approved = await cli(fixture, "admin-a", "admin-a-secret-1", ["show", "project-a", "source", reviewId]);
    await cli(fixture, "admin-a", "admin-a-secret-1", [
      "revoke", "project-a", "source", reviewId, stringField(second, "approvalId")
    ]);
    const revoked = await cli(fixture, "admin-a", "admin-a-secret-1", ["show", "project-a", "source", reviewId]);

    // Then
    expect(stringField(first, "reviewerId")).toBe("reviewer-a");
    expect(stringField(approved, "status")).toBe("approved");
    expect(objectArrayField(approved, "approvals")).toHaveLength(2);
    expect(stringField(revoked, "status")).toBe("revoked");
    expect(JSON.stringify(revoked)).not.toContain("secret");
  });
});

async function startFixture(): Promise<ReviewFixture> {
  const fixture = await nativeGitReviewFixture();
  fixtures.push(fixture);
  return fixture;
}

async function cli(fixture: ReviewFixture, username: string, password: string, args: readonly string[]) {
  const cliPath = join(import.meta.dirname, "../../../../core/packages/native-git/src/cli.ts");
  const { stdout } = await run(process.execPath, ["--import", "tsx", cliPath, "review", fixture.baseUrl(), ...args], {
    env: {
      ...process.env,
      DIM_NATIVE_GIT_USERNAME: username,
      DIM_NATIVE_GIT_PASSWORD: password
    }
  });
  expect(stdout).not.toContain(password);
  return parseJsonObject(stdout);
}
