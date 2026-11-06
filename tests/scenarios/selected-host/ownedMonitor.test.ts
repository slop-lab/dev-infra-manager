import { createServer } from "node:http";
import { once } from "node:events";
import { expect, it } from "vitest";
import { ownedMonitorDefaults } from "./config.js";
import { inspectConfiguredMonitor } from "./monitorScenario.js";

it("inspects the same fresh owned session rather than a foreign preconfigured or globally busy session", async () => {
  const paths: string[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture"); paths.push(url.pathname);
    expect(request.headers.authorization).toBe(`Basic ${Buffer.from("fixture:private-fixture-password").toString("base64")}`);
    const values: Record<string, unknown> = { "/experimental/tool/ids": [], "/session/status": { ses_OWNED: { type: "idle" }, ses_FOREIGN: { type: "busy" } },
      "/session": [{ id: "ses_OWNED" }, { id: "ses_FOREIGN" }], "/session/ses_OWNED": { id: "ses_OWNED" }, "/session/ses_OWNED/message": [], "/session/ses_OWNED/children": [],
      "/question": [{ sessionID: "ses_FOREIGN", questions: ["PRIVATE_UNRELATED_QUESTION"] }], "/permission": [] };
    response.setHeader("content-type", "application/json"); response.end(JSON.stringify(values[url.pathname]));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture has no listener");
    const evidence = await inspectConfiguredMonitor({ profile: ownedMonitorDefaults, workspace: "dim-smoke-owned", endpoint: `http://127.0.0.1:${address.port}`, sessionId: "ses_OWNED", directory: "/workspace",
      credentials: { username: "fixture", password: "private-fixture-password" }, async run() { throw new Error("read-only ownership inspection must not execute guest commands without an explicit adapter"); } });
    expect(evidence.sessions.map(({ sessionId }) => sessionId)).toEqual(["ses_OWNED"]);
    expect(evidence).toMatchObject({ state: "idle", pendingQuestions: 0, discovery: "complete-child-tree", completion: "not-assessed" });
    expect(paths).not.toContain("/session/ses_FOREIGN/message"); expect(JSON.stringify(evidence)).not.toContain("PRIVATE_UNRELATED_QUESTION");
  } finally { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); }
});
