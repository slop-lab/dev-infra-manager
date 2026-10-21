import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { managedProjectFixture } from "./nativeProjectIntegrationFixture.js";
import { createNativeProjectConsole, invokeNativeProjectConsole } from "../../../../packages/host/plugins/native-git/src/projectConsole.js";
import { importNativeProjectPublicRepository, type PublicRepositoryImportDependencies } from "../../../../packages/host/plugins/native-git/src/publicRepositoryImport.js";
import { createNodeNativeGitRootImporterClient } from "../../../../packages/host/plugins/native-git/src/nativeGitRootImporterClient.js";
import { cleanupFinalizeFixtures, generationId, humanReviewer } from "../../../control-plane/plugins/git-repositories/nativeRootImportFinalizeFixture.js";
const execute = promisify(execFile), roots: string[] = [];
afterEach(async () => { await cleanupFinalizeFixtures(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function git(directory: string, args: string[]) { return execute("/usr/bin/git", ["-C", directory, ...args]); }
async function fixture() {
  const f = await managedProjectFixture(); roots.push(f.root);
  await writeFile(join(f.root, "reviewer.json"), JSON.stringify({ schemaVersion: 1, serviceId: "native-main", baseUrl: f.service.origin, generationId, ...humanReviewer }), { mode: 0o600 });
  const env = { ...process.env, DIM_MANAGED_STATE_ROOT: f.state, DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE: f.hostFile, DIM_NATIVE_ROOT_IMPORTER_CONNECTION_FILE: f.importerConnectionFile };
  const sources = new Map<string, string>(), calls: string[] = [];
  for (const id of ["public", "private"]) {
    const source = join(f.root, `url-${id}`); await mkdir(source, { mode: 0o700 });
    await git(source, ["init", "--initial-branch=main"]); await mkdir(join(source, ".dim"));
    await writeFile(join(source, "README.md"), `${id} repository\n`);
    await writeFile(join(source, ".dim/repos.yml"), "untrusted: remote policy must never be interpreted\n");
    await git(source, ["add", "."]); await git(source, ["-c", "user.name=DIM Test", "-c", "user.email=dim@example.invalid", "commit", "-m", "initial"]);
    const marker = join(f.root, "untrusted-hook-ran");
    const hook = join(source, ".git/hooks/post-checkout"); await writeFile(hook, `#!/bin/sh\ntouch '${marker}'\n`); await chmod(hook, 0o700);
    sources.set(`https://github.com/mjy9088/codyssey-${id}.git`, source);
  }
  const deps: PublicRepositoryImportDependencies = { async prepareSource(input) { calls.push(input.url); const directory = sources.get(input.url); if (!directory) throw new Error("unexpected fixture URL"); return { directory, selectedRef: "refs/heads/main", cleanup: async () => {} }; } };
  return { ...f, env, deps, sources, calls };
}
it("creates a project and imports public/private repositories with host review policy, immutable retries and first-repository defaults", async () => {
  const f = await fixture(), runtime = await createNativeProjectConsole(f.env, generationId, f.deps);
  expect(runtime.operations.some((operation) => operation.name === "projects.create")).toBe(true);
  expect(await runtime.invoke("projects.create", { projectId: "codyssey" })).toEqual({ projectId: "codyssey", name: "codyssey", repositoryIds: [] });
  const publicInput = { projectId: "codyssey", repositoryId: "public", url: "https://github.com/mjy9088/codyssey-public.git" };
  const imported = await runtime.invoke("repositories.import", publicInput);
  expect(imported).toMatchObject({ projectId: "codyssey", repositoryId: "public", protectedRef: "refs/heads/main", projectReady: true });
  const publicSource = f.sources.get(publicInput.url)!;
  await writeFile(join(publicSource, "README.md"), "upstream changed after lost response\n"); await git(publicSource, ["add", "."]); await git(publicSource, ["-c", "user.name=DIM Test", "-c", "user.email=dim@example.invalid", "commit", "-m", "advanced upstream"]);
  expect(await runtime.invoke("repositories.import", publicInput)).toEqual(imported);
  expect(f.calls).toEqual([publicInput.url]);
  const draftPath = join(f.state, "native-project-drafts/codyssey/public.json");
  const draft = JSON.parse(await readFile(draftPath, "utf8")) as Record<string, unknown>; delete draft.importReceipt; draft.phase = "import-pending";
  await writeFile(draftPath, JSON.stringify(draft), { mode: 0o600 });
  expect(await runtime.invoke("repositories.import", publicInput)).toEqual(imported);
  expect(f.calls).toHaveLength(1);
  await expect(runtime.invoke("repositories.import", { ...publicInput, url: "https://github.com/mjy9088/other.git" })).rejects.toThrow("immutable source intent");
  await runtime.invoke("repositories.import", { projectId: "codyssey", repositoryId: "private", url: "https://github.com/mjy9088/codyssey-private.git" });
  const record = await f.store.read("codyssey", f.connection.hostId);
  expect(record).toMatchObject({ phase: "ready", configurationRepositoryId: "public", defaultWorkingRepositoryId: "public" });
  expect(record!.repositories.public!.repositoryPolicy.extensions).toEqual({ "code-review": { requiredReviewerIds: [], pathReviewerRules: [{ pathPrefix: ".dim/", reviewerIds: ["owner"] }] }, "merge-policy": {} });
  expect(await runtime.invoke("projects.list", {})).toMatchObject({ projects: [{ projectId: "project-a", repositoryIds: [] }, { projectId: "codyssey", repositoryIds: ["private", "public"] }] });
  const importer = await createNodeNativeGitRootImporterClient(f.importerConnectionFile), proof = await importer.proveRepository("codyssey", "public", AbortSignal.timeout(5000));
  expect(proof.importReceipt).toMatchObject({ expectedCommit: record!.repositories.public!.commit, resolvedTree: record!.repositories.public!.tree });
  await expect(readFile(join(f.root, "untrusted-hook-ran"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(importNativeProjectPublicRepository({ name: "codyssey", projectId: "codyssey", repositoryId: "public", url: publicInput.url, stateRoot: f.state, selected: f.connection, registrarConnectionFile: f.registrarConnectionFile, importerConnectionFile: f.importerConnectionFile, reviewerId: "owner", extensions: {}, signal: AbortSignal.timeout(10_000) }, f.deps)).rejects.toThrow("immutable policy");
});
it("requires valid generation-bound management roles and rejects malformed or private URLs before acquisition", async () => {
  const f = await fixture(), runtime = await createNativeProjectConsole(f.env, generationId, f.deps);
  await runtime.invoke("projects.create", { projectId: "codyssey" });
  for (const url of ["http://github.com/example/repo.git", "https://user:pass@github.com/example/repo.git", "https://127.0.0.1/repo.git", "https://github.com/example/repo.git?token=secret", "file:///tmp/repo"]) await expect(runtime.invoke("repositories.import", { projectId: "codyssey", repositoryId: "public", url })).rejects.toThrow();
  expect(f.calls).toEqual([]);
  await expect(invokeNativeProjectConsole("repositories.import", { projectId: "codyssey", repositoryId: "public", url: "https://github.com/example/repo.git" }, "b".repeat(64), f.env, f.deps)).rejects.toThrow("generation changed");
  await rm(f.registrarConnectionFile);
  const reviewOnly = await createNativeProjectConsole(f.env);
  expect(reviewOnly.operations.some((operation) => operation.name === "repositories.import")).toBe(false);
  await expect(reviewOnly.invoke("projects.create", { projectId: "another" })).rejects.toThrow("unavailable");
});

it("never advertises management with a foreign selected role or revoked registrar credential", async () => {
  const f = await fixture(), original = JSON.parse(await readFile(f.registrarConnectionFile, "utf8")) as { hostId: string; credential: { password: string } };
  await writeFile(f.registrarConnectionFile, JSON.stringify({ ...original, hostId: "host-b" }));
  await expect(createNativeProjectConsole(f.env, generationId, f.deps)).rejects.toThrow("role conflicts");
  await writeFile(f.registrarConnectionFile, JSON.stringify({ ...original, credential: { ...original.credential, password: "x".repeat(43) } }));
  await expect(createNativeProjectConsole(f.env, generationId, f.deps)).rejects.toThrow();
  expect(f.calls).toEqual([]);
  expect(await f.store.read("codyssey", f.connection.hostId)).toBeUndefined();
});
