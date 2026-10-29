import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("runs standalone repository, review and CI through portable providers and durable restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "gs-ci-standalone-"));
  const execute = promisify(execFile);
  try {
    const result = await execute(process.execPath, ["--import", "tsx", "--conditions=source",
      new URL("./public-driver.ts", import.meta.url).pathname, root], {
      cwd: new URL("../..", import.meta.url).pathname,
      env: { ...process.env, GIT_MASTER: "1" },
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const report: unknown = JSON.parse(result.stdout);
    expect(report).toMatchObject({
      missingEvidenceDenied: true,
      missingProviderDenied: true,
      submittedWithoutDimProfile: true,
      pendingAfterDelivery: 0,
      restartOutboxHealthy: true,
      promoted: { outcome: "promoted", sequence: 1 },
    });
    if (!report || typeof report !== "object" || !("candidateCommit" in report) || !("protectedHead" in report)) {
      throw new Error("standalone CI report is missing Git identities");
    }
    expect(report.protectedHead).toBe(report.candidateCommit);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 90_000);
