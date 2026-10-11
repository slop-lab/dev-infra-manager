import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { issueNativeProjectDraftRootReadLease, LifecycleState,
  NativeProjectDraftRootReadError } from "../../../../core/packages/core/src/index.js";
import { generationId, importer, rootReadIssuer,
  activateFinalizeServiceForGeneration, activationTokenB, closeFinalizeService, generationB,
  rootRepository, startFinalizeServiceForGeneration
} from "../../native-git/test/nativeRootImportFinalizeFixture.js";
import { cleanupNativeProjectDraftRootReadFixtures, nativeProjectDraftRootReadFixture,
  runGitAuthenticated, writeImporterConnection,
  writeIssuerConnection } from "./nativeProjectDraftRootReadFixture.js";
import { descendantCommit, seedRootPromotion } from "../../native-git/test/nativeCurrentRootProofFixture.js";

const run = promisify(execFile);

afterEach(cleanupNativeProjectDraftRootReadFixtures);

describe("trusted native Project draft root read", () => {
  it("clones only the imported protected root without changing draft or Project state", async () => {
    const fixture = await nativeProjectDraftRootReadFixture();
    const draftBefore = await readFile(fixture.recordPath);

    const lease = await issueNativeProjectDraftRootReadLease({ stateRoot: fixture.root, name: "acme",
      importerConnectionFile: fixture.importerConnectionFile,
      issuerConnectionFile: fixture.issuerConnectionFile, signal: AbortSignal.timeout(10_000) });

    expect(lease).toMatchObject({ projectId: "project-a", rootRepositoryId: "root", generationId });
    const clone = join(fixture.root, "clone");
    const repositoryUrl = `${fixture.service.origin}/v1/projects/project-a/repositories/root.git`;
    await runGitAuthenticated(["clone", repositoryUrl, clone], lease.username, lease.password);
    expect(await readFile(join(clone, "README.md"), "utf8")).toBe("trusted imported root\n");
    await expect(runGitAuthenticated(["ls-remote",
      `${fixture.service.origin}/v1/projects/project-b/repositories/root.git`],
    lease.username, lease.password)).rejects.toThrow();
    await writeFile(join(clone, "denied.txt"), "denied\n");
    await run("/usr/bin/git", ["-C", clone, "add", "denied.txt"]);
    await run("/usr/bin/git", ["-C", clone, "-c", "user.name=DIM Test", "-c",
      "user.email=dim@example.invalid", "commit", "-m", "denied push"]);
    await expect(runGitAuthenticated(["-C", clone, "push", repositoryUrl,
      "HEAD:refs/heads/proposals/host/change"], lease.username, lease.password)).rejects.toThrow();
    expect(await readFile(fixture.recordPath)).toEqual(draftBefore);
    expect(await new LifecycleState(fixture.root).listProjects()).toEqual([]);
  });

  it("uses active generation B to prove and fetch an unchanged generation-A draft", async () => {
    // Given
    const fixture = await nativeProjectDraftRootReadFixture();
    if (fixture.draft.phase !== "root-imported") throw new Error("fixture did not import root");
    const draftBefore = await readFile(fixture.recordPath);
    await closeFinalizeService(fixture.service);
    const servingB = await startFinalizeServiceForGeneration(
      fixture.serviceRoot, generationB, activationTokenB
    );
    await activateFinalizeServiceForGeneration(servingB.origin, generationB, activationTokenB);
    await writeImporterConnection(fixture.importerConnectionFile, servingB.origin,
      { generationId: generationB });
    await writeIssuerConnection(fixture.issuerConnectionFile, servingB.origin,
      { generationId: generationB });

    // When
    const lease = await issue(fixture);

    // Then
    expect(lease.generationId).toBe(generationB);
    expect(fixture.draft.importReceipt.generationId).toBe(generationId);
    const clone = join(fixture.root, "clone-generation-b");
    await runGitAuthenticated(["clone",
      `${servingB.origin}/v1/projects/project-a/repositories/root.git`, clone],
    lease.username, lease.password);
    expect(await readFile(join(clone, "README.md"), "utf8")).toBe("trusted imported root\n");
    expect(await readFile(fixture.recordPath)).toEqual(draftBefore);
  });

  it("keeps the original draft receipt while denying an unattested descendant", async () => {
    // Given
    const fixture = await nativeProjectDraftRootReadFixture();
    if (fixture.draft.phase !== "root-imported") throw new Error("fixture did not import root");
    const before = await readFile(fixture.recordPath);
    const promoted = await descendantCommit(fixture.serviceRoot, fixture.draft.expectedTree,
      fixture.draft.expectedCommit);
    await seedRootPromotion({ root: fixture.serviceRoot, candidateCommit: promoted,
      candidateTree: fixture.draft.expectedTree });

    // When
    const lease = issue(fixture);

    // Then
    await expect(lease).rejects.toBeInstanceOf(NativeProjectDraftRootReadError);
    expect(fixture.draft.importReceipt.expectedCommit).toBe(fixture.draft.expectedCommit);
    expect(await readFile(fixture.recordPath)).toEqual(before);
  });

  it.each(["pending", "corrupt-artifact", "moved-protected-ref"] as const)(
    "refuses a %s draft without changing its current host record", async (scenario) => {
      const fixture = await nativeProjectDraftRootReadFixture();
      if (fixture.draft.phase !== "root-imported") throw new Error("fixture did not import root");
      switch (scenario) {
        case "pending": {
          const { importReceipt: _receipt, ...draft } = fixture.draft;
          await writeFile(fixture.recordPath, `${JSON.stringify({ ...draft, phase: "import-pending" })}\n`,
            { mode: 0o600 });
          break;
        }
        case "corrupt-artifact":
          await writeFile(fixture.artifactPath, Buffer.alloc(fixture.draft.bundleSize, 0x78));
          break;
        case "moved-protected-ref": {
          const moved = (await run("/usr/bin/git", ["--git-dir", rootRepository(fixture.serviceRoot),
            "-c", "user.name=DIM Test", "-c", "user.email=dim@example.invalid", "commit-tree",
            fixture.draft.expectedTree, "-m", "moved root"])).stdout.trim();
          await run("/usr/bin/git", ["--git-dir", rootRepository(fixture.serviceRoot), "update-ref",
            "refs/heads/main", moved, fixture.draft.expectedCommit]);
          break;
        }
        default:
          assertNever(scenario);
      }
      const before = await readFile(fixture.recordPath);

      await expect(issue(fixture)).rejects.toBeInstanceOf(NativeProjectDraftRootReadError);

      expect(await readFile(fixture.recordPath)).toEqual(before);
      expect(await new LifecycleState(fixture.root).listProjects()).toEqual([]);
    }
  );

  it.each([
    ["endpoint", "http://127.0.0.1:1"],
    ["serviceId", "foreign-native"],
    ["role", "operator-root-importer"],
    ["hostId", "host-b"],
    ["generationId", "b".repeat(64)],
    ["credential", { username: importer.username, password: rootReadIssuer.password }],
    ["credential", { username: rootReadIssuer.username, password: importer.password }]
  ] as const)("refuses mismatched or overlapping %s connections", async (field, value) => {
    const fixture = await nativeProjectDraftRootReadFixture();
    await writeIssuerConnection(fixture.issuerConnectionFile, fixture.service.origin, { [field]: value });

    await expect(issue(fixture)).rejects.toBeInstanceOf(NativeProjectDraftRootReadError);
  });

  it("refuses a foreign-owner live proof", async () => {
    const fixture = await nativeProjectDraftRootReadFixture();
    const foreignPassword = Buffer.alloc(32, 56).toString("base64url");
    await writeImporterConnection(fixture.importerConnectionFile, fixture.service.origin, {
      hostId: "host-b", credential: { username: "project-root-importer-b", password: foreignPassword }
    });
    await writeIssuerConnection(fixture.issuerConnectionFile, fixture.service.origin, {
      hostId: "host-b", credential: { username: "project-root-read-issuer-b",
        password: Buffer.alloc(32, 57).toString("base64url") }
    });

    await expect(issue(fixture)).rejects.toBeInstanceOf(NativeProjectDraftRootReadError);
  });

  it("withholds a minted lease when the imported draft changes before the final reread", async () => {
    let releaseVerification: (() => void) | undefined;
    const verificationBlocked = new Promise<void>((resolve) => {
      releaseVerification = resolve;
    });
    let verificationStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      verificationStarted = resolve;
    });
    const fixture = await nativeProjectDraftRootReadFixture({ beforeVerification: async () => {
      verificationStarted?.();
      await verificationBlocked;
    } });
    if (fixture.draft.phase !== "root-imported") throw new Error("fixture did not import root");
    const pending = issue(fixture);
    await started;
    const { importReceipt: _receipt, ...draft } = fixture.draft;
    await writeFile(fixture.recordPath, `${JSON.stringify({ ...draft, phase: "import-pending" })}\n`,
      { mode: 0o600 });
    releaseVerification?.();

    await expect(pending).rejects.toBeInstanceOf(NativeProjectDraftRootReadError);
  });
});

function issue(fixture: Awaited<ReturnType<typeof nativeProjectDraftRootReadFixture>>) {
  return issueNativeProjectDraftRootReadLease({ stateRoot: fixture.root, name: "acme",
    importerConnectionFile: fixture.importerConnectionFile,
    issuerConnectionFile: fixture.issuerConnectionFile, signal: AbortSignal.timeout(10_000) });
}

function assertNever(value: never): never {
  throw new Error(`unexpected root read rejection scenario: ${String(value)}`);
}
