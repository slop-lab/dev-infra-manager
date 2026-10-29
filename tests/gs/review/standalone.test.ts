import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("runs the GS review and merge lifecycle with real Git and survives restart without DIM", async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "gs-review-standalone-"));
  const execute = promisify(execFile);
  const driver = new URL("./standalone-driver.ts", import.meta.url).pathname;

  try {
    // When
    const result = await execute(process.execPath, ["--import", "tsx", "--conditions=source", driver, root], {
      cwd: new URL("../..", import.meta.url).pathname,
      env: { ...process.env, GIT_MASTER: "1" },
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const report: unknown = JSON.parse(result.stdout);

    // Then
    expect(report).toMatchObject({
      initialStatus: "pending",
      approvedStatus: "approved",
      revokedStatus: "revoked",
      promoted: { outcome: "already-current", sequence: 1 },
      crashObserved: true,
      recoveredSequence: 1,
      restartedStatus: "stale",
      providerFailureClosed: true,
      persistedPathsPreserved: true,
      epochAdvanced: true,
    });
    if (!report || typeof report !== "object"
      || !("initialCommit" in report) || !("candidateCommit" in report) || !("protectedHead" in report)) {
      throw new Error("standalone review report is missing real Git identities");
    }
    expect(report.initialCommit).not.toBe(report.candidateCommit);
    expect(report.protectedHead).toBe(report.candidateCommit);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 90_000);
