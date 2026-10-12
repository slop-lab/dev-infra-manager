import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { admitNativeRootCiProject } from "../../../../core/packages/core/src/nativeRootCiHostAdmission.js";
import { bundleSecrets } from "../../native-git/test/bundleConfigFixture.js";
import { generationId } from "../../native-git/test/nativeRootImportFinalizeFixture.js";
import { reservationFixture, type ReservationFixture } from "./nativeRootClaimReservationFixture.js";

const fixtures: ReservationFixture[] = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("native root CI Project admission client", () => {
  it("attests registrar scope and prints an exact current native Project binding", async () => {
    // Given
    const fixture = await reservationFixture("native-root-ci-host-admission");
    fixtures.push(fixture);
    const root = await mkdtemp(join(tmpdir(), "dim-native-root-ci-admission-"));
    roots.push(root);
    const configPath = join(root, "admission.json");
    await writeFile(configPath, JSON.stringify({ schemaVersion: 1, generationId,
      ordinaryCi: { transport: "loopback-http", endpoint: fixture.origin, serviceId: "ordinary-main",
        registrar: { username: "ordinary-registrar", password: bundleSecrets.registrar } } }), { mode: 0o600 });
    await chmod(configPath, 0o600);

    // When
    const response = await admitNativeRootCiProject("project-a", configPath);

    // Then
    expect(response.serviceId).toBe("ordinary-main");
    expect(response.servingGenerationId).toBe(generationId);
    expect(response.admission.importedRoot.projectId).toBe("project-a");
    expect(response.admission.importedRoot.policy.requiredJobs.some((job) => job.kind === "ordinary-sysbox")).toBe(true);
  }, 20_000);
});
