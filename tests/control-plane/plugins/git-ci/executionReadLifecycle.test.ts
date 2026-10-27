import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { executionGrantSchema } from "@slop-lab/dim-contracts-ci/execution";
import * as gateApi from "../../../../packages/control-plane/plugins/git-repositories/src/native-root-read-lifecycle.js";
import * as backend from "../../../../packages/control-plane/plugins/git-repositories/src/backend.js";
import { nativeBundleReviewFixture, publishedReviewEnvelopes } from "./nativeBundleReviewFixture.js";
import { cleanupFinalizeFixtures, closeFinalizeService, generationId } from "../git-repositories/nativeRootImportFinalizeFixture.js";
import { idleNativeConfig } from "../git-repositories/bundleConfigFixture.js";
import { slot } from "../../../contracts/ci/executionFixture.js";

afterEach(async () => { vi.restoreAllMocks(); await cleanupFinalizeFixtures(); });

it("holds execution Git read admission until backend completion so shutdown drains the active stream", async () => {
  // Given a real granted execution and read lease, with observable admission lifetime.
  let active = 0;
  const createGate = gateApi.createRootReadOperationGate;
  vi.spyOn(gateApi, "createRootReadOperationGate").mockImplementation((maximum) => {
    const gate = createGate(maximum);
    return { ...gate, acquire() {
      const release = gate.acquire();
      if (release === undefined) return;
      active += 1; let held = true;
      return () => { if (held) { held = false; active -= 1; release(); } };
    } };
  });
  const fixture = await nativeBundleReviewFixture("execution-read-drain");
  const envelope = (await publishedReviewEnvelopes(fixture.root))[0];
  const event = envelope?.events[0];
  if (event === undefined) throw new Error("fixture execution event missing");
  const config = idleNativeConfig();
  const headers = (credential: { readonly username: string; readonly password: string }) => ({
    authorization: `Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString("base64")}`,
    "x-dim-generation-id": generationId, "content-type": "application/json"
  });
  const granted = await fetch(`${fixture.service.origin}/v1/execution-grants`, { method: "POST", headers: headers(config.ci.grantIssuer),
    body: JSON.stringify({ executionId: randomUUID(), generationId, event, workerId: "worker-a", slotId: "primary", profile: slot.profile }) });
  expect(granted.status).toBe(201);
  const grant = executionGrantSchema.parse(await granted.json());
  const leased = await fetch(`${fixture.service.origin}/v1/executions/project-a/root/${grant.executionId}/read-lease`, {
    method: "POST", headers: headers(config.ci.candidateReader), body: "{}"
  });
  expect(leased.status).toBe(201);
  const credentials: unknown = await leased.json();
  if (typeof credentials !== "object" || credentials === null || !("username" in credentials) || !("password" in credentials)
    || typeof credentials.username !== "string" || typeof credentials.password !== "string") throw new Error("fixture execution lease missing");
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let activeAtBackend = 0;
  vi.spyOn(backend, "serveGitBackend").mockImplementation(async ({ response }) => {
    activeAtBackend = active; entered.resolve(); await release.promise;
    response.writeHead(200).end("fixture Git stream");
  });
  const reading = fetch(`${fixture.service.origin}/v1/projects/project-a/repositories/root.git/info/refs?service=git-upload-pack`, {
    headers: headers({ username: credentials.username, password: credentials.password })
  });
  let closing: Promise<void> | undefined;
  try {
    // When the transport remains active and service shutdown starts.
    await entered.promise;
    expect(activeAtBackend).toBeGreaterThan(0);
    let closed = false;
    closing = closeFinalizeService(fixture.service).then(() => { closed = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    // Then the stream owns admission until its completion, not just authority inspection.
    expect(closed).toBe(false);
    release.resolve();
    expect(await (await reading).text()).toBe("fixture Git stream");
    await closing;
  } finally { release.resolve(); await reading; await closing; }
});
