import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const [repositoryPath, contractsPath, servicePath, root] = process.argv.slice(2);
if (!repositoryPath || !contractsPath || !servicePath || !root) throw new Error("public driver arguments are required");
const repository: typeof import("../../../packages/gs/repository/src/index.js") = await import(pathToFileURL(repositoryPath).href);
const contracts: typeof import("../../../packages/gs/repository-contracts/src/index.js") = await import(pathToFileURL(contractsPath).href);
const service: typeof import("../../../packages/gs/repository-service/src/index.js") = await import(pathToFileURL(servicePath).href);
const execute = promisify(execFile);
const storageRoot = join(root, "storage");
const source = join(root, "source");
const selector = { namespaceId: "tenant", repositoryId: "main" } as const;
const bare = join(storageRoot, selector.namespaceId, `${selector.repositoryId}.git`);
await mkdir(root, { recursive: true, mode: 0o700 });
const gitVersion = (await git(["--version"])).replace(/^git version /, "");
await repository.initializeRepository({ gitExecutable: "/usr/bin/git", gitVersion, storageRoot }, selector);
await git(["init", source]);
await git(["-C", source, "config", "user.name", "Public Driver"]);
await git(["-C", source, "config", "user.email", "driver@example.invalid"]);
await writeFile(join(source, "README.md"), "initial\n");
await git(["-C", source, "add", "README.md"]);
await git(["-C", source, "commit", "-m", "initial"]);
const initialCommit = await git(["-C", source, "rev-parse", "HEAD"]);
const initialTree = await git(["-C", source, "rev-parse", "HEAD^{tree}"]);
await git(["--git-dir", bare, "fetch", source, "HEAD:refs/heads/main"]);
await writeFile(join(source, "README.md"), "candidate\n");
await git(["-C", source, "commit", "-am", "candidate"]);
const candidateCommit = await git(["-C", source, "rev-parse", "HEAD"]);
const candidateTree = await git(["-C", source, "rev-parse", "HEAD^{tree}"]);
const proposalRef = "refs/heads/proposals/public-driver";
await git(["--git-dir", bare, "fetch", source, `HEAD:${proposalRef}`]);
const policyBase = { schemaVersion: 1 as const, protectedRef: "refs/heads/main", extensions: {} };
const policy = { ...policyBase, policyRevision: contracts.repositoryPolicyRevision(policyBase) };
const runtime = { gitExecutable: "/usr/bin/git", gitVersion, storageRoot };
const gitIdentity = await repository.assertGitVersion(runtime);
const statePath = join(root, "authority.sqlite3");
const authority = await service.openRepositoryAuthority({
  statePath,
  runtime,
  gitIdentity,
  refUpdatePolicies: [{ name: "allow-all", revision: "f".repeat(64), async authorize() {} }],
});
const registered = await authority.registerRepository({
  selector,
  ownerPrincipalId: "public-driver-owner",
  policy,
  branches: [{ protectedRef: "refs/heads/main", commit: initialCommit, tree: initialTree }],
});
const catalogSelectors = await authority.listSelectors();
const change = {
  ...selector,
  proposalRef,
  expectedCommit: initialCommit,
  candidateCommit,
  candidateTree,
  authorizationId: "a".repeat(64),
  evidenceDigest: "b".repeat(64),
};
const promoted = await authority.mutate(selector, async ({ authority: borrowed, target }) => {
  await borrowed.assertCurrent(target);
  return borrowed.promote(change);
});
const retry = await authority.promote(change);
const finalized = await authority.findFinalized({
  ...change,
  protectedRef: registered.head.protectedRef,
  expectedTree: registered.head.tree,
  incarnationId: registered.incarnationId,
  authorityEpoch: registered.authorityEpoch,
  policyDigest: registered.policyDigest,
  ownerPrincipalId: registered.ownerPrincipalId,
  refPolicyRevision: registered.refPolicyRevision,
});
await authority.close();
const restarted = await service.openRepositoryAuthority({
  statePath,
  runtime,
  gitIdentity,
  refUpdatePolicies: [{ name: "allow-all", revision: "f".repeat(64), async authorize() {} }],
});
const recovered = await restarted.resolve(selector);
await restarted.close();
console.log(JSON.stringify({
  promoted,
  retry,
  protectedHead: await git(["--git-dir", bare, "rev-parse", "refs/heads/main"]),
  candidateCommit,
  incarnationPreserved: registered.incarnationId === recovered.incarnationId,
  epochAdvanced: registered.authorityEpoch !== recovered.authorityEpoch,
  authorityEpochBound: registered.authorityEpoch === authority.authorityEpoch,
  policySnapshotFrozen: Object.isFrozen(registered.policy) && Object.isFrozen(registered.policy.extensions),
  catalogSelectors,
  finalizedReceipt: finalized?.receipt,
}));

async function git(args: readonly string[]): Promise<string> {
  return (await execute("/usr/bin/git", args, { env: { ...process.env, LC_ALL: "C" } })).stdout.trim();
}
