import { rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import * as repositoryGit from "../../../../packages/control-plane/plugins/git-repositories/src/repository.js";
import { basic, fixture, generationId, git, reviewer } from "./optionalFeaturesFixture.js";
import { controlPlanePlugin as diffPlugin } from "@slop-lab/dim-control-plane-plugin-git-diff";
import { controlPlanePlugin as blamePlugin } from "@slop-lab/dim-control-plane-plugin-git-blame";

it.each([["diff", 0], ["blame", 0], ["diff", 512], ["blame", 512]] as const)("reads tag-only history through %s with %i extra data tags and bounded Git calls", async (operation, dataTags) => {
  // Given: data tags sort before the only ref advertising the candidate commit.
  const diff = await diffPlugin.configure({}), blame = await blamePlugin.configure({});
  const f = await fixture(true, [...diff.extensions ?? [], ...blame.extensions ?? []]);
  try {
    await writeFile(join(f.source, "README.md"), "tag-only candidate\n");
    const candidate = await f.commit();
    const blob = (await git("/usr/bin/git", ["-C", f.source, "rev-parse", "HEAD:README.md"])).stdout.trim();
    const tree = (await git("/usr/bin/git", ["-C", f.source, "rev-parse", "HEAD^{tree}"])).stdout.trim();
    const algorithm = (await git("/usr/bin/git", ["-C", f.source, "rev-parse", "--show-object-format"])).stdout.trim();
    if (algorithm !== "sha1" && algorithm !== "sha256") throw new Error("unexpected Git object format");
    const data = Array.from({ length: dataTags }, (_, index) => Buffer.from(`distinct data tag ${index}\n`));
    if (data.length > 0) {
      const imported = git("/usr/bin/git", ["-C", f.source, "fast-import", "--quiet"]);
      imported.child.stdin?.end(Buffer.concat(data.flatMap(bytes => [Buffer.from(`blob\ndata ${bytes.length}\n`), bytes, Buffer.from("\n")])));
      await imported;
    }
    const extra = data.map((bytes, index) => `${createHash(algorithm).update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])).digest("hex")}:refs/tags/00-data-${index}`);
    await git("/usr/bin/git", ["-C", f.source, "push", "origin", `${blob}:refs/tags/00-blob`, `${tree}:refs/tags/01-tree`, `${candidate}:refs/tags/99-candidate`, ...extra]);
    const identities = vi.spyOn(repositoryGit, "assertGitExecutableIdentity");

    // When
    const response = await fetch(`${f.origin}/v1/projects/project/repositories/main/${operation}`, {
      method: "POST", headers: { authorization: basic(reviewer), "x-dim-generation-id": generationId, "content-type": "application/json" },
      body: JSON.stringify(operation === "diff" ? { baseCommit: f.initial, headCommit: candidate }
        : { commit: candidate, path: "README.md", line: 1 })
    });

    // Then
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toMatchObject(operation === "diff" ? { baseCommit: f.initial, headCommit: candidate }
      : { commit: candidate, path: "README.md", line: 1 });
    expect(identities.mock.calls.length).toBeLessThan(200);
  } finally { vi.restoreAllMocks(); await f.service.close(); await rm(f.root, { recursive: true, force: true }); }
}, 20_000);
