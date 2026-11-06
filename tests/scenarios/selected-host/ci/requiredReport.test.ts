import { expect, it } from "vitest";
import { practicalRequiredLanes, requirePracticalReport } from "./requiredReport.js";
const source = "a".repeat(40), image = `sha256:${"b".repeat(64)}`;
function report() {
  return { outcome: "passed", driverSourceSha: source, installedSourceSha: source, isolatedUpdate: { status: "PASS" }, results: ["local", "practical-ssh"].map((host) => ({
    host, workspace: { id: "11111111-1111-4111-8111-111111111111" }, outcome: "passed", runtimeVersions: { image }, auxiliaryVm: { id: "22222222-2222-4222-8222-222222222222", image: "c".repeat(64) },
    inference: { sessionId: `ses_${host.replace("-", "")}`, provider: "dim-chat", model: "dim-ci-file-model", accounting: { requestIds: ["correlated-request"], providerQualification: "not-assessed", model: "dim-ci-file-model", workspaceId: "11111111-1111-4111-8111-111111111111", projectId: "practical-ci", routeId: "ci", nonce: "f".repeat(32), principalId: "e".repeat(64) } },
    sessionModel: { sessionId: `ses_${host.replace("-", "")}`, provider: "dim-chat", model: "dim-ci-file-model" }, monitor: { discovery: "complete-child-tree", state: "idle", pendingQuestions: 0, pendingPermissions: 0, currentFailures: 0, unknownSessions: 0, sessions: [{ sessionId: `ses_${host.replace("-", "")}` }] },
    endpoints: [{ kind: "application", disposition: "verified-then-discarded" }, { kind: "coding-agent", disposition: "verified-then-discarded" }], lanes: practicalRequiredLanes.map((name) => ({ name, status: "PASS" }))
  })) };
}
it("requires both real execution selections and every declared required runtime proof", () => {
  expect(requirePracticalReport(report(), source, image).outcome).toBe("passed");
});
it("never qualifies missing, stale, skipped or foreign-session runtime coverage", () => {
  expect(() => requirePracticalReport({ ...report(), results: [] }, source, image)).toThrow();
  expect(() => requirePracticalReport(report(), "d".repeat(40), image)).toThrow();
  expect(() => requirePracticalReport(report(), source, `sha256:${"e".repeat(64)}`)).toThrow();
  for (const name of practicalRequiredLanes) {
    const changed = report();
    for (const row of changed.results) row.lanes = row.lanes.filter((lane) => lane.name !== name);
    expect(() => requirePracticalReport(changed, source, image)).toThrow();
  }
  const changed = report();
  for (const row of changed.results) row.sessionModel.sessionId = "ses_FOREIGN";
  expect(() => requirePracticalReport(changed, source, image)).toThrow();
  expect(() => requirePracticalReport({ ...report(), isolatedUpdate: { status: "BLOCKED" } }, source, image)).toThrow();
});
