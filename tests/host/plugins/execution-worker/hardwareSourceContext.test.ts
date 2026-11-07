import { expect, it } from "vitest";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { gitHttpFixture } from "../../../support/gitHttpFixture.js";
import { openNativeGitCandidateReadAuthority } from "../../../../packages/host/plugins/execution-worker/src/nativeGitCandidateReadAuthority.js";
import { spawnSync } from "node:child_process";

it.each(["sha1", "sha256"] as const)("exports exact bounded immediate merge parents and reconstructs clean %s bundle", async format => {
  const f = await gitHttpFixture(format);
  let reader: ReturnType<typeof openNativeGitCandidateReadAuthority> | undefined;
  try {
    const writer = join(f.root, "writer"); await f.git(f.root, ["clone", f.url("project-a", "source"), writer]);
    await f.git(writer, ["config", "user.name", "fixture"]); await f.git(writer, ["config", "user.email", "fixture@invalid"]);
    const initial = (await f.git(writer, ["rev-parse", "HEAD"])).stdout.trim();
    await f.git(writer, ["checkout", "-b", "left"]); await writeFile(join(writer, "left"), "left\n");
    await f.git(writer, ["add", "."]); await f.git(writer, ["commit", "-m", "left"]);
    const first = (await f.git(writer, ["rev-parse", "HEAD"])).stdout.trim();
    await f.git(writer, ["checkout", "-b", "right", initial]); await writeFile(join(writer, "right"), "right\n");
    await f.git(writer, ["add", "."]); await f.git(writer, ["commit", "-m", "right"]);
    const second = (await f.git(writer, ["rev-parse", "HEAD"])).stdout.trim();
    await f.git(writer, ["checkout", "left"]); await f.git(writer, ["merge", "--no-ff", "right", "-m", "merge"]);
    const candidate = (await f.git(writer, ["rev-parse", "HEAD"])).stdout.trim(), tree = (await f.git(writer, ["rev-parse", "HEAD^{tree}"])).stdout.trim();
    await f.git(writer, ["push", "origin", "HEAD:refs/heads/proposals/workspace-a/candidate"]);
    await f.git(f.root, ["--git-dir", f.repositoryPath("project-a", "source"), "update-ref", "refs/heads/main", candidate]);
    const root = join(f.root, "private"); await mkdir(root, { mode: 0o700 });
    reader = openNativeGitCandidateReadAuthority({ gitExecutable: f.config.gitExecutable, serviceEndpoint: f.baseUrl,
      credential: { username: "reader-a", password: "reader-a-secret-1" }, temporaryRoot: root,
      claim: { projectId: "project-a", repositoryId: "source", protectedRef: "refs/heads/main", expectedProtectedHead: candidate, candidateCommit: candidate, candidateTree: tree } });
    const scope = { projectId: "project-a", repositoryId: "source", signal: AbortSignal.timeout(20000) }, source = join(root, "source"), context = join(root, "context");
    await reader.materializeTree({ ...scope, commitObjectId: candidate, treeObjectId: tree, destination: source });
    await expect(reader.readCommit({ ...scope, objectId: first })).rejects.toThrow("outside the claim");
    await reader.exportSourceContext!({ ...scope, mode: "candidate-and-immediate-parents", destination: context });
    const metadata = JSON.parse(await readFile(join(context, "context.json"), "utf8"));
    expect(metadata.parents.map((p: { commit: string }) => p.commit)).toEqual([first, second]);
    expect(await readFile(join(context, "parents", first, "left"), "utf8")).toBe("left\n");
    await expect(reader.exportSourceContext!({ ...scope, projectId: "project-b", mode: "candidate-and-immediate-parents", destination: join(root, "foreign") })).rejects.toThrow("outside the claim");
    const descriptor = join(root, "descriptor.json"); await writeFile(descriptor, JSON.stringify({ candidateCommit: candidate, candidateTree: tree }));
    const helper = new URL("../../../../scripts/ci/practical-source.ts", import.meta.url).href;
    const child = spawnSync(process.execPath, ["--input-type=module", "--eval", `const {reconstructPracticalSource}=await import(${JSON.stringify(helper)});console.log(JSON.stringify({node:process.version,result:await reconstructPracticalSource(${JSON.stringify(source)},${JSON.stringify(context)},${JSON.stringify(descriptor)})}));`],
      { env: { PATH: process.env.PATH, HOME: process.env.HOME }, encoding: "utf8", timeout: 10000 });
    expect(child.status, child.stderr).toBe(0);
    const native = JSON.parse(child.stdout); expect(native.node).toBe(process.version);
    expect(native.result).toEqual({ commit: candidate, tree, parents: [first, second] });
    expect((await f.git(source, ["rev-list", "--all"])).stdout.trim().split("\n")).toHaveLength(3);
    await expect(f.git(source, ["cat-file", "-e", initial])).rejects.toThrow();
    const bundle = join(root, "candidate.bundle"), clone = join(root, "clone"); await f.git(source, ["bundle", "create", bundle, "HEAD"]);
    await f.git(root, ["clone", bundle, clone]); expect((await f.git(clone, ["rev-parse", "HEAD"])).stdout.trim()).toBe(candidate);
    expect((await f.git(clone, ["rev-parse", "HEAD^"])).stdout.trim()).toBe(first);
    expect((await f.git(clone, ["status", "--porcelain"])).stdout).toBe("");
    if (format === "sha1") {
      const parents = [initial, first, second, candidate];
      for (let index = 0; index < 5; index++) parents.push((await f.git(writer, ["commit-tree", tree, "-p", initial, "-m", `extra-${index}`])).stdout.trim());
      const nine = (await f.git(writer, ["commit-tree", tree, ...parents.flatMap(parent => ["-p", parent]), "-m", "nine"])).stdout.trim();
      await f.git(writer, ["push", "origin", `${nine}:refs/heads/proposals/workspace-a/nine`]);
      await f.git(f.root, ["--git-dir", f.repositoryPath("project-a", "source"), "update-ref", "refs/heads/main", nine]);
      const bounded = openNativeGitCandidateReadAuthority({ gitExecutable: f.config.gitExecutable, serviceEndpoint: f.baseUrl,
        credential: { username: "reader-a", password: "reader-a-secret-1" }, temporaryRoot: root,
        claim: { projectId: "project-a", repositoryId: "source", protectedRef: "refs/heads/main", expectedProtectedHead: nine, candidateCommit: nine, candidateTree: tree } });
      try { await expect(bounded.exportSourceContext!({ ...scope, mode: "candidate-and-immediate-parents", destination: join(root, "too-many") })).rejects.toThrow("eight distinct"); }
      finally { await bounded.close(); }
      const limited = openNativeGitCandidateReadAuthority({ gitExecutable: f.config.gitExecutable, serviceEndpoint: f.baseUrl,
        credential: { username: "reader-a", password: "reader-a-secret-1" }, temporaryRoot: root,
        limits: { maximumMaterializedBytes: 1 }, claim: { projectId: "project-a", repositoryId: "source", candidateCommit: candidate, candidateTree: tree } });
      try { await expect(limited.exportSourceContext!({ ...scope, mode: "candidate-and-immediate-parents", destination: join(root, "over-budget") })).rejects.toThrow("shared materialization budget"); }
      finally { await limited.close(); }
    }
  } finally { await reader?.close(); await f.close(); }
}, 30000);
