import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { managedProjectFixture } from "./nativeProjectIntegrationFixture.js";
import { createNativeProjectConsole, describeNativeProjectConsole, invokeNativeProjectConsole } from "../../../../packages/host/plugins/native-git/src/projectConsole.js";
import { runNativeGitCli } from "../../../../packages/host/plugins/native-git/src/cli/index.js";
import { cleanupFinalizeFixtures, generationId, humanReviewer, hostPromoter } from "../../../control-plane/plugins/git-repositories/nativeRootImportFinalizeFixture.js";
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await cleanupFinalizeFixtures(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const f = await managedProjectFixture(); roots.push(f.root);
  const reviewer = join(f.root, "reviewer.json"), promoter = join(f.root, "promoter.json");
  await writeFile(reviewer, JSON.stringify({ schemaVersion: 1, serviceId: "native-main", baseUrl: f.service.origin, generationId, ...humanReviewer }), { mode: 0o600 });
  await writeFile(promoter, JSON.stringify({ schemaVersion: 1, serviceId: "native-main", endpoint: f.service.origin, generationId, role: "host-promoter", hostId: hostPromoter.hostId, credential: { username: hostPromoter.username, password: hostPromoter.password } }), { mode: 0o600 });
  return { ...f, reviewer, promoter, env: { ...process.env, DIM_MANAGED_STATE_ROOT: f.state, DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE: f.hostFile } };
}
it("discovers ready multi-repository projects dynamically through the CLI without exposing host role connections", async () => {
  const f = await fixture(); await f.importRepository("public");
  const runtime = await createNativeProjectConsole(f.env);
  expect(await runtime.invoke("projects.list", {})).toEqual({ reviewerId: "owner", projects: [{ projectId: "project-a", name: "acme", repositoryIds: ["public"] }] });
  await f.importRepository("private");
  expect(await runtime.invoke("projects.list", {})).toEqual({ reviewerId: "owner", projects: [{ projectId: "project-a", name: "acme", repositoryIds: ["private", "public"] }] });
  expect(await runtime.invoke("reviews.list", { projectId: "project-a", repositoryId: "private" })).toEqual([]);
  await expect(runtime.invoke("reviews.list", { projectId: "other", repositoryId: "public" })).rejects.toThrow("current project catalog");
  await expect(invokeNativeProjectConsole("reviews.list", { projectId: "project-a", repositoryId: "missing" }, generationId, f.env)).rejects.toThrow("current project catalog");
  const description = await describeNativeProjectConsole(f.env);
  expect(description).toMatchObject({ schemaVersion: 1, generationId, reviewerId: "owner", projects: [{ projectId: "project-a", repositoryIds: ["private", "public"] }] });
  expect(description.operations.some((op) => op.name === "reviews.promote")).toBe(true);
  expect(description.operations.some((op) => op.name.startsWith("sync."))).toBe(false);
  for (const secret of [humanReviewer.password, hostPromoter.password, f.reviewer, f.promoter, "workspaceWriteIssuer", "credential"]) expect(JSON.stringify(description)).not.toContain(secret);
  vi.stubEnv("DIM_MANAGED_STATE_ROOT", f.state); vi.stubEnv("DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE", f.hostFile);
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  await runNativeGitCli(["project", "console", "describe", "--json"]);
  expect(JSON.parse(String(output.mock.calls.at(-1)?.[0]))).toEqual(description);
  await runNativeGitCli(["project", "console", "invoke", "reviews.list", "--expected-generation", generationId, "--input", JSON.stringify({ projectId: "project-a", repositoryId: "public" }), "--json"]);
  expect(JSON.parse(String(output.mock.calls.at(-1)?.[0]))).toEqual([]);
});
it("does not advertise repositories imported for a previous control-plane generation", async () => {
  const f = await fixture(); await f.importRepository("public");
  const file = join(f.state, "projects/acme.json"), record = JSON.parse(await readFile(file, "utf8")) as { repositories: { public: { importReceipt: { generationId: string } } } };
  record.repositories.public.importReceipt.generationId = "b".repeat(64);
  await writeFile(file, JSON.stringify(record), { mode: 0o600 });
  expect(await (await createNativeProjectConsole(f.env)).invoke("projects.list", {})).toMatchObject({ projects: [{ projectId: "project-a", repositoryIds: [] }] });
  await expect(invokeNativeProjectConsole("reviews.list", { projectId: "project-a", repositoryId: "public" }, generationId, f.env)).rejects.toThrow("current project catalog");
});
it("rejects same-directory reviewer/promoter files for a different selected endpoint, generation or host", async () => {
  const f = await fixture();
  const original = JSON.parse(await readFile(f.reviewer, "utf8")) as Record<string, unknown>;
  for (const patch of [{ generationId: "b".repeat(64) }, { baseUrl: "http://127.0.0.1:1" }]) {
    await writeFile(f.reviewer, JSON.stringify({ ...original, ...patch }));
    await expect(createNativeProjectConsole(f.env)).rejects.toThrow("conflicts with selected control plane");
  }
  await writeFile(f.reviewer, JSON.stringify(original));
  const promoter = JSON.parse(await readFile(f.promoter, "utf8")) as Record<string, unknown>;
  await writeFile(f.promoter, JSON.stringify({ ...promoter, hostId: "host-b" }));
  await expect(createNativeProjectConsole(f.env)).rejects.toThrow("conflicts with selected control plane");
  await writeFile(f.promoter, JSON.stringify(promoter)); await chmod(f.reviewer, 0o644);
  await expect(createNativeProjectConsole(f.env)).rejects.toThrow("connection");
});

it("fences cached console generations before a review mutation or refreshed discovery", async () => {
  const f = await fixture(); await f.importRepository("public");
  const selected = JSON.parse(await readFile(f.hostFile, "utf8")) as { nativeGit: { generationId: string } };
  selected.nativeGit.generationId = "b".repeat(64);
  await writeFile(f.hostFile, JSON.stringify(selected));
  await expect(invokeNativeProjectConsole("reviews.approve", { projectId: "project-a", repositoryId: "public", reviewId: "a".repeat(64) }, generationId, f.env)).rejects.toThrow("generation changed; reconnect");
  await expect(describeNativeProjectConsole(f.env, generationId)).rejects.toThrow("generation changed; reconnect");
});
