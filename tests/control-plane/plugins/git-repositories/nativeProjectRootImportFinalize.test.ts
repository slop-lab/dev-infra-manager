import { join } from "node:path";
import { access } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { refValue } from "../../../support/gitHelpers.js";
import { createTraversalRejectingGit } from "./realGitIdentity.js";
import {
  activateFinalizeService,
  cleanupFinalizeFixtures,
  closeFinalizeService,
  createFinalizeRoot,
  createRootBundle,
  finalizeRootImport,
  generationId,
  importer,
  parseImportReceipt,
  projectInput,
  rootRepository,
  runGit,
  startFinalizeService,
  uploadRootBundle
} from "./nativeRootImportFinalizeFixture.js";

afterEach(cleanupFinalizeFixtures);

describe("native Project root import finalization", () => {
  it("imports a received bundle without a whole-repository integrity traversal", async () => {
    // Given
    const root = await createFinalizeRoot("finalize-bounded-validation");
    const bundle = await createRootBundle();
    const initialService = await startFinalizeService(root);
    await activateFinalizeService(initialService.origin);
    await initialService.prepareProject(generationId, importer.hostId, projectInput("project-a"));
    await uploadRootBundle(initialService.origin, bundle);
    await closeFinalizeService(initialService);
    const database = new DatabaseSync(join(root, "native-idle.sqlite3"));
    database.prepare("UPDATE native_project_root_import SET phase = 'installing'").run();
    database.close();
    const runtimeGit = await createTraversalRejectingGit(await createFinalizeRoot("finalize-bounded-git"));

    // When
    await startFinalizeService(root, undefined, undefined, undefined, undefined, {
      gitExecutable: runtimeGit.gitExecutable,
      gitVersion: runtimeGit.gitVersion
    });

    // Then
    await expect(access(runtimeGit.forbiddenInvocation)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await refValue(rootRepository(root), "refs/heads/main")).toBe(bundle.commit);
  });

  it("installs one bound commit and tree, creates only the unborn protected ref, and exactly replays", async () => {
    const root = await createFinalizeRoot("finalize");
    const bundle = await createRootBundle();
    const service = await startFinalizeService(root);
    await activateFinalizeService(service.origin);
    await service.prepareProject(generationId, importer.hostId, projectInput("project-a"));
    const receiptResponse = await uploadRootBundle(service.origin, bundle);
    expect(receiptResponse.status).toBe(200);
    const receipt = parseImportReceipt(await receiptResponse.json());
    const selector = {
      schemaVersion: 1, generationId, importNonce: receipt.importNonce, bundleDigest: receipt.bundleDigest
    } as const;

    const response = await finalizeRootImport(service.origin, selector);
    const finalized = await response.json();

    expect(response.status).toBe(200);
    expect(finalized).toEqual({ ...receipt, resolvedTree: bundle.tree, phase: "repository-imported" });
    expect(await refValue(rootRepository(root), "refs/heads/main")).toBe(bundle.commit);
    const refs = await runGit("/usr/bin/git", ["--git-dir", rootRepository(root),
      "for-each-ref", "--format=%(refname)"]);
    expect(refs.stdout).toBe("refs/heads/main\n");
    const database = new DatabaseSync(join(root, "native-idle.sqlite3"), { readOnly: true });
    expect(database.prepare("SELECT phase, resolved_tree FROM native_project_root_import").get())
      .toEqual({ phase: "repository-imported", resolved_tree: bundle.tree });
    expect(database.prepare(
      "SELECT name FROM sqlite_schema WHERE name IN ('native_project_reader', 'native_project_writer')"
    ).all()).toEqual([]);
    database.close();
    const replay = await finalizeRootImport(service.origin, selector);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(finalized);
  });

  it.each(["object-install", "cas"] as const)(
    "startup converges after the %s crash window",
    async (window) => {
      const root = await createFinalizeRoot(`${window}-crash`);
      const bundle = await createRootBundle();
      const service = await startFinalizeService(root);
      await activateFinalizeService(service.origin);
      await service.prepareProject(generationId, importer.hostId, projectInput("project-a"));
      const receipt = parseImportReceipt(await (await uploadRootBundle(service.origin, bundle)).json());
      await closeFinalizeService(service);
      const repository = rootRepository(root);
      const bundlePath = join(root, "project-a", ".dim-import-root", `${receipt.importNonce}.bundle`);
      const database = new DatabaseSync(join(root, "native-idle.sqlite3"));
      if (window === "object-install") {
        database.prepare("UPDATE native_project_root_import SET phase = 'installing'").run();
        await runGit("/usr/bin/git", ["--git-dir", repository, "bundle", "unbundle", bundlePath]);
      } else {
        await runGit("/usr/bin/git", ["--git-dir", repository, "bundle", "unbundle", bundlePath]);
        database.prepare(
          "UPDATE native_project_root_import SET phase = 'objects-installed', resolved_tree = ?"
        ).run(bundle.tree);
        await runGit("/usr/bin/git", ["--git-dir", repository, "update-ref", "refs/heads/main",
          bundle.commit, "0".repeat(40)]);
      }
      database.close();

      await startFinalizeService(root);

      const recovered = new DatabaseSync(join(root, "native-idle.sqlite3"), { readOnly: true });
      expect(recovered.prepare("SELECT phase, resolved_tree FROM native_project_root_import").get())
        .toEqual({ phase: "repository-imported", resolved_tree: bundle.tree });
      recovered.close();
      expect(await refValue(repository, "refs/heads/main")).toBe(bundle.commit);
    }
  );
});
