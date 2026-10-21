import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { activateFinalizeService, cleanupFinalizeFixtures, createFinalizeRoot, generationId,
  startFinalizeService } from "../../control-plane/plugins/git-repositories/nativeRootImportFinalizeFixture.js";
import { bundleSecrets } from "../../control-plane/plugins/git-repositories/bundleConfigFixture.js";
import { event, slot } from "../../contracts/ci/executionFixture.js";
afterEach(cleanupFinalizeFixtures);
it("rejects unauthorized, malformed and invented grant requests without mutating Git authority state", async () => {
  const root = await createFinalizeRoot("grant-denial"), service = await startFinalizeService(root);
  await activateFinalizeService(service.origin);
  const state = join(root, "native-idle.sqlite3"), before = await readFile(state);
  const authorization = `Basic ${Buffer.from(`ci-grants:${bundleSecrets.attemptIssuer}`).toString("base64")}`;
  const input = { executionId: randomUUID(), generationId, event: event(), workerId: "worker-a", slotId: "primary", profile: slot.profile };
  const request = (body: unknown, auth = authorization) => fetch(`${service.origin}/v1/execution-grants`, {
    method: "POST", headers: { authorization: auth, "content-type": "application/json", "X-Dim-Generation-Id": generationId },
    body: JSON.stringify(body)
  });
  expect((await request(input, "Basic unknown")).status).toBe(401);
  expect((await request({})).status).toBe(400);
  expect((await request(input)).status).toBe(409);
  expect(await readFile(state)).toEqual(before);
});
