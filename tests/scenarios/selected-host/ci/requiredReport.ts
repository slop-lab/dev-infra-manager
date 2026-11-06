export const practicalRequiredLanes = ["ordinary-workspace-lifecycle-copy-resources", "scoped-router-model-tool-accounting", "scoped-llm-restart-recovery", "application-endpoint", "opencode-authenticated-session-ingress", "owned-opencode-session-monitor", "auxiliary-kvm-vm", "recreation-and-service-reconnection"] as const;

export function requirePracticalReport(value: unknown, sourceSha: string, image: string) {
  const report = object(value);
  if (report.outcome !== "passed" || report.driverSourceSha !== sourceSha || report.installedSourceSha !== sourceSha || !Array.isArray(report.results) || report.results.length !== 2) throw new Error("required practical CI coverage is missing or belongs to another source");
  const hosts = new Set<string>();
  for (const raw of report.results) {
    const row = object(raw), workspace = object(row.workspace), inference = object(row.inference), accounting = object(inference.accounting), session = object(row.sessionModel), monitor = object(row.monitor), runtime = object(row.runtimeVersions), vm = object(row.auxiliaryVm);
    if (row.host !== "local" && row.host !== "practical-ssh" || hosts.has(String(row.host)) || row.outcome !== "passed") throw new Error("required local/normal-public-SSH coverage did not run exactly once");
    hosts.add(String(row.host));
    const lanes = row.lanes;
    if (!Array.isArray(lanes) || practicalRequiredLanes.some((name) => !lanes.some((lane: unknown) => object(lane).name === name && object(lane).status === "PASS"))) throw new Error("required practical runtime lane is missing or not passing");
    if (runtime.image !== image || typeof vm.id !== "string" || !/^[a-f0-9-]{36}$/.test(vm.id) || typeof vm.image !== "string" || !/^[a-f0-9]{64}$/.test(vm.image) || typeof inference.sessionId !== "string" || session.sessionId !== inference.sessionId
      || session.provider !== inference.provider || session.model !== inference.model || accounting.providerQualification !== "not-assessed"
      || inference.provider !== "dim-chat" || inference.model !== "dim-ci-file-model" || accounting.model !== inference.model || accounting.workspaceId !== workspace.id
      || accounting.projectId !== "practical-ci" || accounting.routeId !== "ci" || typeof accounting.nonce !== "string" || !/^[a-f0-9]{32}$/.test(accounting.nonce)
      || typeof accounting.principalId !== "string" || !/^[a-f0-9]{64}$/.test(accounting.principalId)
      || !Array.isArray(accounting.requestIds) || accounting.requestIds.length === 0 || !Array.isArray(monitor.sessions)
      || !monitor.sessions.some((entry: unknown) => object(entry).sessionId === inference.sessionId) || monitor.discovery !== "complete-child-tree" || monitor.state !== "idle"
      || monitor.pendingQuestions !== 0 || monitor.pendingPermissions !== 0 || monitor.currentFailures !== 0 || monitor.unknownSessions !== 0) throw new Error("image, Incus, owned-session or scoped accounting proof is incomplete");
    if (!Array.isArray(row.endpoints) || !row.endpoints.some((entry: unknown) => object(entry).kind === "application" && object(entry).disposition === "verified-then-discarded") || !row.endpoints.some((entry: unknown) => object(entry).kind === "coding-agent" && object(entry).disposition === "verified-then-discarded")) throw new Error("required production-envelope HTTP endpoints were not verified");
  }
  if (object(report.isolatedUpdate).status !== "PASS") throw new Error("required running-workspace isolated update continuity did not pass");
  return report;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("required practical CI receipt is malformed");
  return Object.fromEntries(Object.entries(value));
}
