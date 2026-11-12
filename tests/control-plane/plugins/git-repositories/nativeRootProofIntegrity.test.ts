import { execFile } from "node:child_process";
import { access, chmod, cp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { deflateSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  activateFinalizeService,
  authorization,
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
  startFinalizeService,
  uploadRootBundle,
  type RunningService
} from "./nativeRootImportFinalizeFixture.js";
import { createTraversalRejectingGit } from "./realGitIdentity.js";

const run = promisify(execFile);

afterEach(cleanupFinalizeFixtures);

describe("native root bounded proof integrity", () => {
  it("performs ordinary verified reads without fsck or recursive object-store attestation", async () => {
    // Given
    const fixture = await finalizedFixture("bounded-proof");
    await closeFinalizeService(fixture.service);
    await symlink(fixture.root, join(rootRepository(fixture.root), "objects", "unreachable-metadata"));
    const runtimeGit = await createTraversalRejectingGit(await createFinalizeRoot("bounded-proof-git"));
    const service = await startFinalizeService(
      fixture.root, undefined, undefined, undefined, undefined, {
        gitExecutable: runtimeGit.gitExecutable,
        gitVersion: runtimeGit.gitVersion
      }
    );

    // When
    const first = await proof(service.origin);
    const second = await proof(service.origin);

    // Then
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    await expect(access(runtimeGit.forbiddenInvocation)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("restarts and proves an imported root without rereading the complete durable bundle", async () => {
    // Given
    const fixture = await finalizedFixture("bounded-bundle-restart");
    await closeFinalizeService(fixture.service);
    const bundlePath = join(fixture.root, "project-a", ".dim-import-root", `${fixture.receipt.importNonce}.bundle`);
    const bytes = await readFile(bundlePath);
    bytes[0] = (bytes[0] ?? 0) ^ 1;
    await writeFile(bundlePath, bytes, { mode: 0o600 });

    // When
    const restarted = await startFinalizeService(fixture.root);
    await activateFinalizeService(restarted.origin);
    const response = await proof(restarted.origin);

    // Then
    expect(response.status).toBe(200);
  });

  it.each(["commit", "tree"] as const)(
    "rejects valid Git %s bytes stored under the wrong selected object ID",
    async (type) => {
      // Given
      const fixture = await finalizedFixture(`selected-${type}-identity`);
      const repository = rootRepository(fixture.root);
      await materializeLooseObjects(repository, fixture.root);
      if (type === "commit") {
        const replacement = (await run("/usr/bin/git", ["--git-dir", repository,
          "-c", "user.name=DIM Test", "-c", "user.email=dim@example.invalid",
          "commit-tree", fixture.bundle.tree, "-m", "replacement commit"])).stdout.trim();
        await replaceLooseObject(repository, fixture.bundle.commit, replacement, "commit");
      } else {
        const replacement = (await run("/bin/sh", ["-c",
          "exec /usr/bin/git --git-dir \"$1\" mktree </dev/null", "sh", repository])).stdout.trim();
        await replaceLooseObject(repository, fixture.bundle.tree, replacement, "tree");
      }

      // When
      const response = await proof(fixture.service.origin);

      // Then
      expect(response.status).toBe(409);
    }
  );
});

async function finalizedFixture(label: string): Promise<{
  readonly root: string;
  readonly bundle: Awaited<ReturnType<typeof createRootBundle>>;
  readonly receipt: ReturnType<typeof parseImportReceipt>;
  readonly service: RunningService;
}> {
  const root = await createFinalizeRoot(label);
  const bundle = await createRootBundle();
  const service = await startFinalizeService(root);
  await activateFinalizeService(service.origin);
  await service.prepareProject(generationId, importer.hostId, projectInput("project-a"));
  const receipt = parseImportReceipt(await (await uploadRootBundle(service.origin, bundle)).json());
  expect((await finalizeRootImport(service.origin, {
    schemaVersion: 1,
    generationId,
    importNonce: receipt.importNonce,
    bundleDigest: receipt.bundleDigest
  })).status).toBe(200);
  return { root, bundle, receipt, service };
}

async function materializeLooseObjects(repository: string, root: string): Promise<void> {
  const objects = join(repository, "objects");
  const packDirectory = join(objects, "pack");
  const pack = (await readdir(packDirectory)).find((name) => name.endsWith(".pack"));
  if (pack === undefined) throw new TestSetupError("imported root has no pack fixture");
  const loose = join(root, "loose-objects");
  await mkdir(loose, { mode: 0o700 });
  await run("/bin/sh", ["-c",
    "GIT_OBJECT_DIRECTORY=\"$1\" /usr/bin/git --git-dir \"$2\" unpack-objects -r < \"$3\"",
    "sh", loose, repository, join(packDirectory, pack)]);
  for (const name of await readdir(loose)) await cp(join(loose, name), join(objects, name), { recursive: true });
  for (const name of await readdir(packDirectory)) await rm(join(packDirectory, name));
}

async function replaceLooseObject(
  repository: string,
  selectedObjectId: string,
  replacementObjectId: string,
  type: "commit" | "tree"
): Promise<void> {
  const content = (await run("/usr/bin/git", ["--git-dir", repository, "cat-file", type, replacementObjectId], {
    encoding: "buffer"
  })).stdout;
  const directory = join(repository, "objects", selectedObjectId.slice(0, 2));
  await mkdir(directory, { recursive: true });
  const path = join(directory, selectedObjectId.slice(2));
  await chmod(path, 0o600);
  await writeFile(path, deflateSync(Buffer.concat([
    Buffer.from(`${type} ${String(content.length)}\0`), content
  ])));
  await chmod(path, 0o444);
}

function proof(origin: string): Promise<Response> {
  return fetch(`${origin}/v1/projects/project-a/repositories/root/import/proof`, {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify({ schemaVersion: 1, generationId })
  });
}

class TestSetupError extends Error {
  readonly name = "TestSetupError";
}
