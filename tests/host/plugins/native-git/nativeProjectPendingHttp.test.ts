import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { cleanupFinalizeFixtures } from "../../../control-plane/plugins/native-git/nativeRootImportFinalizeFixture.js";
import { bootstrapNativeProjectRepository } from "../../../../packages/host/plugins/native-git/src/nativeProjectBootstrap.js";
import { NativeProjectPendingStore } from "../../../../packages/host/plugins/native-git/src/nativeProjectPendingStore.js";
import { managedProjectFixture } from "./nativeProjectIntegrationFixture.js";

const roots: string[] = [];
afterEach(async () => { await cleanupFinalizeFixtures(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
it("imports independent public/private Git repositories under one Project through actual native authority HTTP", async () => {
  const fixture = await managedProjectFixture(); roots.push(fixture.root);
  const publicImport = await fixture.importRepository("public", "public source"), privateImport = await fixture.importRepository("private", "private source");
  expect(publicImport.draft.expectedCommit).not.toBe(privateImport.draft.expectedCommit);
  const ready = await fixture.store.configure("acme", { configurationRepositoryId: "private", defaultWorkingRepositoryId: "public" }, fixture.connection, AbortSignal.timeout(10_000));
  expect(ready.repositories.public?.importReceipt.repositoryId).toBe("public");
  expect(ready.repositories.private?.importReceipt.repositoryId).toBe("private");
  expect(await new NativeProjectPendingStore(fixture.state).read("acme", fixture.connection.hostId)).toEqual(ready);
  const before = await readFile(path.join(fixture.state, "projects/acme.json"));
  expect(await bootstrapNativeProjectRepository(publicImport.input)).toEqual(publicImport.draft);
  expect(await readFile(path.join(fixture.state, "projects/acme.json"))).toEqual(before);
  // Native Git still has no anonymous read, even for the repository named public.
  expect((await fetch(`${fixture.service.origin}/v1/projects/project-a/repositories/public.git/info/refs?service=git-upload-pack`)).status).toBe(401);
});
