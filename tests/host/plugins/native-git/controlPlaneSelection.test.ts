import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { saveControlPlaneSelection, selectedControlPlaneHostFile, selectedControlPlaneImporterFile } from "../../../../packages/host/plugins/native-git/src/controlPlaneSelection.js";
import { selectNativeProject, nativeProjectImporter } from "../../../../packages/host/plugins/native-git/src/cli/native-project-selector.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "dim-control-selection-")); roots.push(root);
  const environment = { DIM_MANAGED_STATE_ROOT: root };
  const hostConnectionFile = join(root, "host.json"), importerConnectionFile = join(root, "importer.json");
  const credential = (username: string, byte: number) => ({ username, password: Buffer.alloc(32, byte).toString("base64url") });
  const host = { schemaVersion: 1, hostId: "operator", nativeGit: { transport: "loopback-http", endpoint: "http://127.0.0.1:8787",
    serviceId: "native-main", generationId: "a".repeat(64), workspaceWriteIssuer: credential("operator", 1), rootReadIssuer: credential("read-issuer", 2) } };
  const importer = { schemaVersion: 1, endpoint: host.nativeGit.endpoint, serviceId: "native-main", role: "operator-root-importer",
    hostId: "operator", generationId: host.nativeGit.generationId, credential: credential("importer", 3) };
  await writeFile(hostConnectionFile, JSON.stringify(host), { mode: 0o600 });
  await writeFile(importerConnectionFile, JSON.stringify(importer), { mode: 0o600 });
  return { root, environment, host, importer, hostConnectionFile, importerConnectionFile, selection: join(root, "active-control-plane.json") };
}

it("selects private saved host/importer files without environment exports and keeps credentials out of selection", async () => {
  const f = await fixture();
  await saveControlPlaneSelection(f, f.environment);
  expect(await selectedControlPlaneHostFile(f.environment)).toBe(f.hostConnectionFile);
  expect(await selectedControlPlaneImporterFile(f.environment)).toBe(f.importerConnectionFile);
  const project = await selectNativeProject(f.environment);
  expect(project.connection.hostId).toBe("operator");
  expect(await nativeProjectImporter(project)).toBeDefined();
  expect((await stat(f.selection)).mode & 0o777).toBe(0o600);
  const bytes = await readFile(f.selection, "utf8");
  expect(bytes).not.toContain(f.importer.credential.password); expect(bytes).not.toContain("credential");
});

it("gives explicit environment selectors precedence and checks mixed selections before importing", async () => {
  const f = await fixture(); await saveControlPlaneSelection(f, f.environment);
  const other = join(f.root, "other-host.json");
  await writeFile(other, JSON.stringify({ ...f.host, nativeGit: { ...f.host.nativeGit, endpoint: "http://127.0.0.1:9999" } }), { mode: 0o600 });
  const environment = { ...f.environment, DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE: other };
  expect(await selectedControlPlaneHostFile(environment)).toBe(other);
  await expect(nativeProjectImporter(await selectNativeProject(environment))).rejects.toThrow(/conflicts/);
  await chmod(f.selection, 0o644);
  expect(await selectedControlPlaneHostFile(environment)).toBe(other);
  await expect(selectedControlPlaneImporterFile(f.environment)).rejects.toThrow(/private/);
  await expect(selectedControlPlaneHostFile({ ...f.environment, DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE: "" })).rejects.toThrow(/empty/);
});

it("retains a good selection when connections disagree and guides a fresh SSH host to connect", async () => {
  const f = await fixture();
  await expect(selectedControlPlaneHostFile(f.environment)).rejects.toThrow(/control-plane connect/);
  await saveControlPlaneSelection(f, f.environment); const before = await readFile(f.selection);
  await writeFile(f.importerConnectionFile, JSON.stringify({ ...f.importer, generationId: "b".repeat(64) }));
  await expect(saveControlPlaneSelection(f, f.environment)).rejects.toThrow(/same control plane and generation/);
  expect(await readFile(f.selection)).toEqual(before);
});
