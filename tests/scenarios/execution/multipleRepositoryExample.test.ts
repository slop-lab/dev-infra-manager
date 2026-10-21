import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { withNativeGitExecutionReadAuthority } from "../../../packages/host/plugins/execution-worker/src/nativeGitCandidateReadAuthority.js";
import { verifyAndMaterializeCandidate } from "../../../packages/host/plugins/execution-worker/src/candidate.js";
import { cleanupFinalizeFixtures, createFinalizeRoot, runGit } from "../../control-plane/plugins/git-repositories/nativeRootImportFinalizeFixture.js";
import { closeExampleServices } from "./exampleServiceFixture.js";
import { multipleRepositoryExampleFixture } from "./multipleRepositoryExampleFixture.js";

let fixture: Awaited<ReturnType<typeof multipleRepositoryExampleFixture>>;
beforeEach(async () => { fixture = await multipleRepositoryExampleFixture(); }, 30_000);
afterEach(async () => { await closeExampleServices(); await cleanupFinalizeFixtures(); });

it("runs the checked-in private integration workflow against its exact public/private Git snapshots", async () => {
  const f = fixture, grant = await f.authorize("private", "integration");
  expect(grant.descriptor.inputs).toEqual({ private: { commit: grant.descriptor.candidateCommit, tree: grant.descriptor.candidateTree },
    public: f.snapshots.public });
  const credential = await f.source.candidate(grant), directory = await createFinalizeRoot("example-job");
  const workspace = join(directory, "workspace"), scriptFile = join(directory, "script");
  await withNativeGitExecutionReadAuthority({ descriptor: grant.descriptor, gitExecutable: "/usr/bin/git",
    serviceEndpoint: f.service.origin, temporaryRoot: directory, credential }, AbortSignal.timeout(20_000),
  (authority) => verifyAndMaterializeCandidate({ descriptor: grant.descriptor, descriptorDigest: grant.descriptorDigest,
    authority, workspace, scriptFile, signal: AbortSignal.timeout(20_000) }));
  expect((await readdir(directory)).sort()).toEqual(["script", "workspace"]);
  expect((await readdir(workspace)).sort()).toEqual(["private", "public"]);
  for (const repositoryId of ["public", "private"]) expect(await readdir(join(workspace, repositoryId))).not.toContain(".git");
  const execution = await runGit("/bin/bash", ["--noprofile", "--norc", scriptFile], { cwd: join(workspace, "private"), timeout: 10_000 });
  expect(execution.stderr).toBe("");
  expect(execution.stdout).toContain("native-multiple-integration-ok");
  const privateCheck = await runGit("/bin/bash", ["--noprofile", "--norc", ".dim/ci/jobs/source.bash"], {
    cwd: join(workspace, "private"), timeout: 10_000
  });
  expect(privateCheck.stdout).toContain("native-multiple-private-ok");
  // The actual checked-in script must detect an incompatible joint snapshot.
  await writeFile(join(workspace, "public", "api-version.txt"), "incompatible\n");
  await expect(runGit("/bin/bash", ["--noprofile", "--norc", scriptFile], { cwd: join(workspace, "private"), timeout: 10_000 }))
    .rejects.toMatchObject({ code: 1 });
}, 30_000);

it("keeps the checked-in public-only workflow from obtaining private repository bytes", async () => {
  const f = fixture, grant = await f.authorize("public", "public-check");
  expect(Object.keys(grant.descriptor.inputs)).toEqual(["public"]);
  const credential = await f.source.candidate(grant);
  const response = await fetch(`${f.service.origin}/v1/projects/project-a/repositories/private.git/info/refs?service=git-upload-pack`, {
    headers: { authorization: `Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString("base64")}` },
    signal: AbortSignal.timeout(10_000)
  });
  expect(response.status).toBe(403);
  const directory = await createFinalizeRoot("example-public-job"), workspace = join(directory, "workspace");
  const scriptFile = join(directory, "script"), signal = AbortSignal.timeout(20_000);
  await withNativeGitExecutionReadAuthority({ descriptor: grant.descriptor, gitExecutable: "/usr/bin/git",
    serviceEndpoint: f.service.origin, temporaryRoot: directory, credential }, signal,
  (authority) => verifyAndMaterializeCandidate({ descriptor: grant.descriptor, descriptorDigest: grant.descriptorDigest,
    authority, workspace, scriptFile, signal }));
  expect((await readdir(workspace)).sort()).toEqual(["public"]);
  const execution = await runGit("/bin/bash", ["--noprofile", "--norc", scriptFile], { cwd: join(workspace, "public"), timeout: 10_000 });
  expect(execution.stdout).toContain("native-multiple-public-ok");
}, 30_000);
