import { gitPolicy } from "../../../support/git-policy.js";
import { realGitVersion } from "./realGitIdentity.js";
import { createHash } from "node:crypto";
import { chmod, link, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { activationTokenSha256, bindExactActivation } from "../../../../packages/control-plane/plugins/git-repositories/src/native-bundle-activation.js";
import {
  claimNativeProjectRootImport,
  initializeNativeGitBundleState,
  inspectNativeGitBundleState,
  markNativeProjectRootBundleDurable
} from "../../../../packages/control-plane/plugins/git-repositories/src/native-bundle-state.js";
import { executeNativeProjectPreparation } from "../../../../packages/control-plane/plugins/git-repositories/src/native-project-registration.js";

const roots: string[] = [];
const generationId = "a".repeat(64);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("durable native root bundle integrity", () => {
  it("accepts an owned single-link mode-0600 durable bundle without changing state", async () => {
    const { root } = await durableFixture();
    const before = await readFile(join(root, "native-idle.sqlite3"));

    expect(await inspectNativeGitBundleState(root)).toEqual({ stateFormat: 12 });
    expect(await readFile(join(root, "native-idle.sqlite3"))).toEqual(before);
  });

  it.each([
    ["mode-0400", async (_root: string, path: string) => chmod(path, 0o400)],
    ["hard-linked", async (_root: string, path: string) => link(path, `${path}.alias`)]
  ])("rejects a %s bundle without changing durable state", async (_label, change) => {
    const { root, path } = await durableFixture();
    await change(root, path);
    const before = await readFile(join(root, "native-idle.sqlite3"));

    await expect(inspectNativeGitBundleState(root)).rejects.toThrow(/bundle/i);
    await expect(initializeNativeGitBundleState(root)).rejects.toThrow(/bundle/i);
    expect(await readFile(join(root, "native-idle.sqlite3"))).toEqual(before);
  });
});

async function durableFixture(): Promise<{ readonly root: string; readonly path: string }> {
  const root = await mkdtemp(join(tmpdir(), "dim-native-bundle-integrity-"));
  roots.push(root);
  const state = await initializeNativeGitBundleState(root);
  try {
    bindExactActivation(state, generationId, activationTokenSha256(Buffer.alloc(32, 51).toString("base64url")));
    await executeNativeProjectPreparation({
      database: state.database, stateDirectory: root,
      runtimeConfig: { storageRoot: root, gitExecutable: "/usr/bin/git", gitVersion: realGitVersion },
      generationId, ownerHostId: "host-a",
      input: { serviceId: "native-main", projectId: "project-a", repositoryId: "root" }
    });
    const intent = claimNativeProjectRootImport(state, generationId, "host-a", {
      serviceId: "native-main", projectId: "project-a", repositoryId: "root",
      protectedRef: "refs/heads/main", expectedCommit: "c".repeat(40),
      policy: gitPolicy()
    });
    const directory = join(root, "project-a", ".dim-import-root");
    await mkdir(directory, { mode: 0o700 });
    const path = join(directory, `${intent.importNonce}.bundle`);
    const bytes = Buffer.from("private bundle fixture\n");
    await writeFile(path, bytes, { mode: 0o600 });
    markNativeProjectRootBundleDurable(
      state, "project-a", "root", intent.importNonce, createHash("sha256").update(bytes).digest("hex"), bytes.length
    );
    return { root, path };
  } finally {
    await state.owner.release();
  }
}
