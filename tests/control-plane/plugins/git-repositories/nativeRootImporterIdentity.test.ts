import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bundleSecrets } from "./bundleConfigFixture.js";
import {
  activateFinalizeService,
  authorization,
  cleanupFinalizeFixtures,
  createFinalizeRoot,
  generationId,
  importer,
  startFinalizeService,
  wrongHostAuthorization
} from "./nativeRootImportFinalizeFixture.js";

afterEach(cleanupFinalizeFixtures);

describe("native Git root importer identity", () => {
  it("attests the exact configured service, role, host, and generation before activation without mutation", async () => {
    const root = await createFinalizeRoot("importer-identity");
    const service = await startFinalizeService(root);
    const database = join(root, "native-idle.sqlite3");
    const before = await readFile(database);
    const endpoint = `${service.origin}/v1/operator-root-importer-identity`;

    const first = await fetch(endpoint, { headers: { authorization } });
    const second = await fetch(endpoint, { headers: { authorization: wrongHostAuthorization } });

    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toBe("application/json");
    expect(first.headers.get("cache-control")).toBe("no-store");
    const identity = await first.json();
    expect(identity).toEqual({
      schemaVersion: 1, serviceId: "native-main", role: "operator-root-importer",
      hostId: importer.hostId, generationId
    });
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ hostId: "host-b", generationId });
    expect(JSON.stringify(identity)).not.toContain(importer.password);
    expect(await readFile(database)).toEqual(before);
  });

  it("denies foreign roles, unknown credentials, query strings, and other methods without state changes", async () => {
    const root = await createFinalizeRoot("importer-identity-denial");
    const service = await startFinalizeService(root);
    await activateFinalizeService(service.origin);
    const database = join(root, "native-idle.sqlite3");
    const before = await readFile(database);
    const endpoint = `${service.origin}/v1/operator-root-importer-identity`;
    const registrarAuthorization = `Basic ${Buffer.from(
      `registrar-a:${bundleSecrets.projectRegistrar}`
    ).toString("base64")}`;

    const wrongRole = await fetch(endpoint, { headers: { authorization: registrarAuthorization } });
    const unknown = await fetch(endpoint, { headers: {
      authorization: `Basic ${Buffer.from("unknown:credential").toString("base64")}`
    } });
    const queried = await fetch(`${endpoint}?hostId=host-b`, { headers: { authorization } });
    const wrongMethod = await fetch(endpoint, { method: "POST", headers: { authorization } });

    expect([wrongRole.status, unknown.status, queried.status, wrongMethod.status]).toEqual([403, 401, 404, 404]);
    expect(await readFile(database)).toEqual(before);
  });
});
