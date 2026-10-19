import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { verifyAndMaterializeCandidate, type NativeCandidateReadAuthority } from "../../../../packages/host/plugins/ci-worker/src/candidate.js";
import { withNativeGitExecutionReadAuthority } from "../../../../packages/host/plugins/ci-worker/src/nativeGitCandidateReadAuthority.js";
import { executionGrantSchema, executionDescriptorSchema, executionDescriptorDigest } from "../../../../packages/contracts/ci/src/execution-protocol.js";
import { assignment, grant, hash } from "../../../contracts/ci/executionFixture.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture(joint: boolean) {
  const root = await mkdtemp(join(tmpdir(), "dim-ci-inputs-")); roots.push(root);
  const base = grant(assignment()).descriptor, script = Buffer.from("printf checked\n"), config = Buffer.from("jobs: {}\n");
  const inputs = { root: { commit: base.candidateCommit, tree: base.candidateTree },
    ...(joint ? { private: { commit: "7".repeat(40), tree: "8".repeat(40) } } : {}) };
  const descriptor = { ...base, inputs, script: { ...base.script, sha256: `sha256:${hash(script.toString())}` },
    configBlob: { ...base.configBlob, sha256: `sha256:${hash(config.toString())}` } };
  const materialized: string[] = [];
  const authority: NativeCandidateReadAuthority = {
    async resolveProtectedHead() { return descriptor.expectedProtectedHead; },
    async readCommit(input) { const selected = inputs[input.repositoryId as keyof typeof inputs];
      if (!selected || selected.commit !== input.objectId) throw new Error("unselected input");
      return { objectId: selected.commit, treeObjectId: selected.tree }; },
    async readBlob(input) { const selected = input.path === descriptor.configBlob.path ? descriptor.configBlob : descriptor.script;
      return { objectId: selected.objectId, mode: "100644", bytes: input.path === descriptor.configBlob.path ? config : script }; },
    async materializeTree(input) { materialized.push(input.repositoryId); await mkdir(input.destination);
      await writeFile(join(input.destination, "content"), input.commitObjectId);
      return { commitObjectId: input.commitObjectId, treeObjectId: input.treeObjectId }; }
  };
  return { root, descriptor, authority, materialized, workspace: join(root, "workspace"), scriptFile: join(root, "script"),
    signal: new AbortController().signal, descriptorDigest: executionDescriptorDigest(descriptor) };
}
it("materializes only selected pinned repositories into separate directories, including for single-repo jobs", async () => {
  for (const joint of [false, true]) {
    const input = await fixture(joint); await verifyAndMaterializeCandidate(input);
    expect((await readdir(input.workspace)).sort()).toEqual(joint ? ["private", "root"] : ["root"]);
    expect(await readFile(join(input.workspace, "root/content"), "utf8")).toBe(input.descriptor.candidateCommit);
    expect(input.materialized.sort()).toEqual(Object.keys(input.descriptor.inputs).sort());
  }
});
it("rejects an altered dependency tree before materializing it", async () => {
  const input = await fixture(true), readCommit = input.authority.readCommit;
  input.authority.readCommit = async (request) => request.repositoryId === "private"
    ? { objectId: request.objectId, treeObjectId: "9".repeat(40) } : readCommit(request);
  await expect(verifyAndMaterializeCandidate(input)).rejects.toThrow("input repository commit does not match snapshot");
  expect(input.materialized).not.toContain("private");
});
it("does not grant the trusted reader access to a repository absent from the descriptor", async () => {
  const input = await fixture(false);
  await expect(withNativeGitExecutionReadAuthority({ descriptor: input.descriptor, gitExecutable: "/usr/bin/git",
    serviceEndpoint: "http://127.0.0.1:1234", temporaryRoot: input.root,
    credential: { username: "execution-reader", password: "x".repeat(32) } }, input.signal, async (authority) => {
    await authority.readCommit({ projectId: input.descriptor.projectId, repositoryId: "private",
      objectId: "7".repeat(40), signal: input.signal });
  })).rejects.toThrow("repository is outside execution inputs");
});

it("accepts the same numeric-leading repository IDs as native Project registration", () => {
  const base = grant(assignment()).descriptor;
  const descriptor = executionDescriptorSchema.parse({ ...base, repositoryId: "1-app", inputs: {
    "1-app": { commit: base.candidateCommit, tree: base.candidateTree }
  } });
  expect(descriptor.repositoryId).toBe("1-app");
});

it("binds input tuple values rather than JSON key order into grants and descriptor identity", () => {
  const base = grant(assignment());
  const inputs = { ...base.descriptor.inputs, private: { commit: "7".repeat(40), tree: "8".repeat(40) } };
  const descriptor = { ...base.descriptor, inputs };
  const reordered = { ...descriptor, inputs: Object.fromEntries(Object.entries(inputs).reverse()) };
  expect(executionDescriptorDigest(reordered)).toBe(executionDescriptorDigest(descriptor));
  expect(() => executionGrantSchema.parse({ ...base, event: { ...base.event, inputs }, descriptor: reordered,
    descriptorDigest: executionDescriptorDigest(reordered) })).not.toThrow();
  expect(executionDescriptorDigest({ ...descriptor, inputs: { ...inputs, private: { ...inputs.private, tree: "9".repeat(40) } } }))
    .not.toBe(executionDescriptorDigest(descriptor));
});
