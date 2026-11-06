import { expect, it } from "vitest";
import { parseOwnedRun, correlateRouterRequests, verifyOwnedSessionModel } from "./ownedInference.js";

const nonce = "a".repeat(32), scope = { workspaceId: "11111111-1111-4111-8111-111111111111", projectId: "smoke", principalId: "owned-principal", routeId: "default", model: "ci-model", nonce };
const event = (type: string, part: unknown, sessionID = "ses_OWNED") => JSON.stringify({ type, sessionID, part });
const output = [event("step_start", {}), event("tool_use", { tool: "read", state: { status: "completed", output: "PRIVATE_READ" } }),
  event("tool_use", { tool: "write", state: { status: "completed", input: "PRIVATE_WRITE" } }), event("step_finish", { reason: "stop" })].join("\n");

it("learns one fresh session from the same run and retains tool/status metadata without payloads", () => {
  const run = parseOwnedRun(output);
  expect(run).toMatchObject({ sessionId: "ses_OWNED", terminalReason: "stop", tools: [{ tool: "read", status: "completed" }, { tool: "write", status: "completed" }] });
  expect(JSON.stringify(run)).not.toContain("PRIVATE");
});
it("rejects foreign sessions, failed or incomplete output instead of monitoring an unrelated parent", () => {
  for (const invalid of [output + "\n" + event("step_start", {}, "ses_FOREIGN"), event("error", {}), event("step_start", {})]) expect(() => parseOwnedRun(invalid)).toThrow();
});

const request = { id: "22222222-2222-4222-8222-222222222222", project_id: scope.projectId, principal_id: scope.principalId, workspace_id: scope.workspaceId,
  route_id: scope.routeId, attempt_id: "33333333-3333-4333-8333-333333333333", request_nonce: nonce, account_id: "fixture", started_at: 1, finished_at: 2,
  model: scope.model, observed_model: scope.model, outcome: "completed", execution: "completed", delivery: "complete", accounting: "settled", occupied: 0, cancel_requested: 0,
  input_tokens: 10, output_tokens: 5, error_code: null };
it("correlates the run nonce with exact scoped admitted/settled requests, not global usage deltas", () => {
  expect(correlateRouterRequests([request], scope)).toMatchObject({ nonce, requestIds: [request.id], workspaceId: scope.workspaceId, model: scope.model, providerQualification: "not-assessed" });
  for (const changed of [{ workspace_id: "foreign" }, { principal_id: "foreign" }, { project_id: "foreign" }, { route_id: "foreign" }, { model: "default-free" }, { request_nonce: "b".repeat(32) }, { accounting: "reconciliation_required" }]) {
    expect(() => correlateRouterRequests([{ ...request, ...changed }], scope)).toThrow();
  }
  expect(() => correlateRouterRequests([], scope)).toThrow();
});

it("does not attribute file output to DIM when the owned session used a different provider", async () => {
  const run = { sessionId: "ses_OWNED", provider: "dim-chat", model: "ci-model" };
  const client = (providerID: string) => ({ async get() { return [{ info: { sessionID: run.sessionId, role: "assistant", providerID, modelID: run.model } }]; } });
  await expect(verifyOwnedSessionModel(client("dim-chat"), run)).resolves.toMatchObject({ sessionId: run.sessionId });
  await expect(verifyOwnedSessionModel(client("free-default"), run)).rejects.toThrow("expected DIM provider/model");
});
