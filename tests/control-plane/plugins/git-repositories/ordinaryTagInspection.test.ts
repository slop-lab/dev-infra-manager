import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { basic, fixture, generationId, git, reviewer } from "./optionalFeaturesFixture.js";
import { controlPlanePlugin as diffPlugin } from "@slop-lab/dim-control-plane-plugin-git-diff";
import { controlPlanePlugin as blamePlugin } from "@slop-lab/dim-control-plane-plugin-git-blame";

it.each(["diff", "blame"] as const)("reads tag-only commit history through %s despite preceding blob and tree tags", async (operation) => {
  // Given: data tags sort before the only ref advertising the candidate commit.
  const diff = await diffPlugin.configure({}), blame = await blamePlugin.configure({});
  const f = await fixture(true, [...diff.extensions ?? [], ...blame.extensions ?? []]);
  try {
    await writeFile(join(f.source, "README.md"), "tag-only candidate\n");
    const candidate = await f.commit();
    const blob = (await git("/usr/bin/git", ["-C", f.source, "rev-parse", "HEAD:README.md"])).stdout.trim();
    const tree = (await git("/usr/bin/git", ["-C", f.source, "rev-parse", "HEAD^{tree}"])).stdout.trim();
    await git("/usr/bin/git", ["-C", f.source, "push", "origin", `${blob}:refs/tags/00-blob`, `${tree}:refs/tags/01-tree`, `${candidate}:refs/tags/99-candidate`]);

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
  } finally { await f.service.close(); await rm(f.root, { recursive: true, force: true }); }
}, 20_000);
