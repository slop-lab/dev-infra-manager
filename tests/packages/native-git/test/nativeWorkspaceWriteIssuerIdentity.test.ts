import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bundleSecrets } from "./bundleConfigFixture.js";
import {
  cleanupFinalizeFixtures,
  createFinalizeRoot,
  generationId,
  rootReadIssuerAuthorization,
  startFinalizeService,
  workspaceWriteIssuer,
  workspaceWriteIssuerAuthorization
} from "./nativeRootImportFinalizeFixture.js";

afterEach(cleanupFinalizeFixtures);

describe("native Git workspace write issuer identity", () => {
  it("attests the exact noncacheable service, role, host, and serving generation without mutation", async () => {
    // Given
    const root = await createFinalizeRoot("workspace-write-issuer-identity");
    const service = await startFinalizeService(root);
    const database = join(root, "native-idle.sqlite3");
    const before = await readFile(database);

    // When
    const response = await fetch(`${service.origin}/v1/operator-workspace-write-issuer-identity`, {
      headers: { authorization: workspaceWriteIssuerAuthorization }
    });

    // Then
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      schemaVersion: 1, serviceId: "native-main", role: "operator-workspace-write-issuer",
      hostId: workspaceWriteIssuer.hostId, generationId
    });
    expect(await readFile(database)).toEqual(before);
  });

  it("denies foreign roles, forged credentials, query strings, and other methods before mutation", async () => {
    // Given
    const root = await createFinalizeRoot("workspace-write-issuer-identity-denial");
    const service = await startFinalizeService(root);
    const database = join(root, "native-idle.sqlite3");
    const before = await readFile(database);
    const endpoint = `${service.origin}/v1/operator-workspace-write-issuer-identity`;
    const registrarAuthorization = `Basic ${Buffer.from(
      `registrar-a:${bundleSecrets.projectRegistrar}`
    ).toString("base64")}`;

    // When
    const responses = await Promise.all([
      fetch(endpoint, { headers: { authorization: rootReadIssuerAuthorization } }),
      fetch(endpoint, { headers: { authorization: registrarAuthorization } }),
      fetch(endpoint, { headers: { authorization: `Basic ${Buffer.from("host-a:forged").toString("base64")}` } }),
      fetch(`${endpoint}?generation=current`, { headers: { authorization: workspaceWriteIssuerAuthorization } }),
      fetch(endpoint, { method: "POST", headers: { authorization: workspaceWriteIssuerAuthorization } })
    ]);

    // Then
    expect(responses.map((response) => response.status)).toEqual([403, 403, 401, 404, 404]);
    expect(await readFile(database)).toEqual(before);
  });
});
