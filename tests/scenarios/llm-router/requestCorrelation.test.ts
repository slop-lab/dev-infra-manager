import { expect, it } from "vitest";
import { fixture } from "./attachmentFixture.js";
import { invokeRouterOperation } from "../../../packages/control-plane/plugins/llm-router/src/operations.js";

it("records a bounded client nonce with admitted workspace/project/principal/route metadata through the actual gateway", async () => {
  const f = await fixture(), nonce = "a".repeat(32);
  const response = await fetch(`${f.gatewayOrigin}/v1/responses`, { method: "POST", headers: { authorization: `Bearer ${f.token}`, "content-type": "application/json", "x-dim-request-nonce": nonce },
    body: JSON.stringify({ model: "reviewed-model", input: "test-owned protocol request" }) });
  expect(response.status).toBe(200); await response.text();
  const requests = await invokeRouterOperation(f.cpConfig, f.cp.ledger, "requests", { projectId: "application", limit: 20 }, "test-reader", "read");
  expect(requests).toEqual([expect.objectContaining({ id: response.headers.get("x-dim-request-id"), project_id: "application", workspace_id: f.workspace.id,
    principal_id: expect.any(String), route_id: "default", attempt_id: expect.any(String), request_nonce: nonce, model: "reviewed-model", accounting: "settled", outcome: "completed" })]);
  expect(JSON.stringify(requests)).not.toContain(f.token);
});

it("rejects malformed correlation metadata before admitting provider work", async () => {
  const f = await fixture();
  const response = await fetch(`${f.gatewayOrigin}/v1/responses`, { method: "POST", headers: { authorization: `Bearer ${f.token}`, "content-type": "application/json", "x-dim-request-nonce": "not-a-run-nonce" },
    body: JSON.stringify({ model: "reviewed-model", input: "must-not-dispatch" }) });
  expect(response.status).toBe(400); await response.body?.cancel();
  expect(Number(f.cp.ledger.database.prepare("SELECT COUNT(*) AS n FROM requests").get()?.n)).toBe(0);
});
