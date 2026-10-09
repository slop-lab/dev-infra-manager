import { link, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { refValue } from "./nativeGitHarness.js";
import {
  activateFinalizeService,
  cleanupFinalizeFixtures,
  closeFinalizeService,
  createFinalizeRoot,
  createRootBundle,
  finalizeRootImport,
  generationId,
  importer,
  type ImportReceipt,
  parseImportReceipt,
  projectInput,
  rootRepository,
  runGit,
  startFinalizeService,
  uploadRootBundle,
  wrongHostAuthorization
} from "./nativeRootImportFinalizeFixture.js";

afterEach(cleanupFinalizeFixtures);

describe("native Project root import finalize rejection", () => {
  it("authenticates before admission and rejects changed selectors without mutation", async () => {
    const fixture = await durableFixture("selector-rejection");
    const selector = exactSelector(fixture.receipt);
    const requests = [
      [401, selector, `Basic ${Buffer.from("unknown:credential").toString("base64")}`],
      [404, selector, wrongHostAuthorization],
      [400, { ...selector, extra: true }, undefined],
      [409, { ...selector, generationId: "b".repeat(64) }, undefined],
      [409, { ...selector, bundleDigest: "b".repeat(64) }, undefined]
    ] as const;

    for (const [status, body, auth] of requests) {
      const response = await finalizeRootImport(fixture.service.origin, body, auth);
      expect(response.status).toBe(status);
      expect(await refValue(rootRepository(fixture.root), "refs/heads/main")).toBeUndefined();
    }
    const database = new DatabaseSync(join(fixture.root, "native-idle.sqlite3"), { readOnly: true });
    expect(database.prepare("SELECT phase, resolved_tree FROM native_project_root_import").get())
      .toEqual({ phase: "bundle-durable", resolved_tree: null });
    database.close();
  });

  it("does not adopt a preexisting protected ref even when it equals the bound commit", async () => {
    const fixture = await durableFixture("preexisting-ref");
    const repository = rootRepository(fixture.root);
    const bundlePath = join(fixture.root, "project-a", ".dim-root-import", `${fixture.receipt.importNonce}.bundle`);
    await runGit("/usr/bin/git", ["--git-dir", repository, "bundle", "unbundle", bundlePath]);
    await runGit("/usr/bin/git", ["--git-dir", repository, "update-ref", "refs/heads/main",
      fixture.bundle.commit, "0".repeat(40)]);

    const response = await finalizeRootImport(fixture.service.origin, exactSelector(fixture.receipt));

    expect(response.status).toBe(409);
    expect(await refValue(repository, "refs/heads/main")).toBe(fixture.bundle.commit);
    await closeFinalizeService(fixture.service);
    await expect(startFinalizeService(fixture.root)).rejects.toThrow(/foreign ref|protected ref|root import/i);
    expect(await refValue(repository, "refs/heads/main")).toBe(fixture.bundle.commit);
  });

  it("rejects a corrupt protected ref before changing the import phase or installing objects", async () => {
    const fixture = await durableFixture("corrupt-ref");
    const repository = rootRepository(fixture.root);
    const path = join(repository, "refs", "heads", "main");
    await writeFile(path, "invalid-object-id\n", { mode: 0o600 });

    const response = await finalizeRootImport(fixture.service.origin, exactSelector(fixture.receipt));

    expect(response.status).toBe(409);
    const database = new DatabaseSync(join(fixture.root, "native-idle.sqlite3"), { readOnly: true });
    expect(database.prepare("SELECT phase FROM native_project_root_import").get()).toEqual({ phase: "bundle-durable" });
    database.close();
    expect(await readFile(path, "utf8")).toBe("invalid-object-id\n");
  });

  it("rejects a hard-linked installed pack before publishing the protected ref", async () => {
    const fixture = await durableFixture("hardlinked-pack");
    const repository = rootRepository(fixture.root);
    const bundlePath = join(fixture.root, "project-a", ".dim-root-import", `${fixture.receipt.importNonce}.bundle`);
    await runGit("/usr/bin/git", ["--git-dir", repository, "bundle", "unbundle", bundlePath]);
    const packDirectory = join(repository, "objects", "pack");
    const pack = (await readdir(packDirectory)).find((name) => name.endsWith(".pack"));
    if (pack === undefined) throw new Error("bundle did not create an installed pack");
    await link(join(packDirectory, pack), join(fixture.root, "project-a", "foreign-pack"));

    const response = await finalizeRootImport(fixture.service.origin, exactSelector(fixture.receipt));

    expect(response.status).toBe(409);
    expect(await refValue(repository, "refs/heads/main")).toBeUndefined();
    const database = new DatabaseSync(join(fixture.root, "native-idle.sqlite3"), { readOnly: true });
    expect(database.prepare("SELECT phase FROM native_project_root_import").get()).toEqual({ phase: "installing" });
    database.close();
  });

  it("leaves the ref unborn and blocks startup when the durable bundle proof changes", async () => {
    const fixture = await durableFixture("changed-bundle");
    const path = join(fixture.root, "project-a", ".dim-root-import", `${fixture.receipt.importNonce}.bundle`);
    const bytes = await readFile(path);
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1;
    await writeFile(path, bytes, { mode: 0o600 });

    const response = await finalizeRootImport(fixture.service.origin, exactSelector(fixture.receipt));

    expect(response.status).toBe(409);
    expect(await refValue(rootRepository(fixture.root), "refs/heads/main")).toBeUndefined();
    await closeFinalizeService(fixture.service);
    await expect(startFinalizeService(fixture.root)).rejects.toThrow(/bundle/i);
  });

  it.each(["generation", "host", "intent"] as const)(
    "blocks startup for a changed durable %s binding",
    async (binding) => {
      const fixture = await durableFixture(`changed-${binding}`);
      await closeFinalizeService(fixture.service);
      const database = new DatabaseSync(join(fixture.root, "native-idle.sqlite3"));
      if (binding === "generation") {
        database.prepare(
          "INSERT INTO bundle_activation (generation_id, activation_token_sha256) VALUES (?, ?)"
        ).run("b".repeat(64), "c".repeat(64));
        database.prepare("UPDATE native_project_root_import SET generation_id = ?").run("b".repeat(64));
      } else if (binding === "host") {
        database.prepare("UPDATE native_project_root_import SET owner_host_id = 'host-b'").run();
      } else {
        const row = database.prepare("SELECT policy_json FROM native_project_root_import").get();
        if (typeof row !== "object" || row === null || !("policy_json" in row)
          || typeof row.policy_json !== "string") throw new Error("missing import policy fixture");
        database.prepare("UPDATE native_project_root_import SET policy_json = ?")
          .run(row.policy_json.replace(
            "1260bff66b3d732abb336c2885d6a69a47e465369083c28875dc9cb09a9a480c",
            "f".repeat(64)
          ));
      }
      database.close();

      await expect(startFinalizeService(fixture.root)).rejects.toThrow(/root import|generation|policy/i);
      expect(await refValue(rootRepository(fixture.root), "refs/heads/main")).toBeUndefined();
    }
  );
});

async function durableFixture(label: string) {
  const root = await createFinalizeRoot(label);
  const bundle = await createRootBundle();
  const service = await startFinalizeService(root);
  await activateFinalizeService(service.origin);
  await service.prepareProject(generationId, importer.hostId, projectInput("project-a"));
  const response = await uploadRootBundle(service.origin, bundle);
  expect(response.status).toBe(200);
  const receipt = parseImportReceipt(await response.json());
  return { root, bundle, service, receipt };
}

function exactSelector(receipt: ImportReceipt) {
  return {
    schemaVersion: 1,
    generationId,
    importNonce: receipt.importNonce,
    bundleDigest: receipt.bundleDigest
  } as const;
}
