import { assertGitVersion } from "../../../packages/gs/repository/src/index.js";
import { openRepositoryAuthority } from "../../../packages/gs/repository-service/src/index.js";

const [statePath, storageRoot, gitExecutable, gitVersion] = process.argv.slice(2);
if (!statePath || !storageRoot || !gitExecutable || !gitVersion) throw new Error("owner driver arguments are required");
const gitIdentity = await assertGitVersion({ gitExecutable, gitVersion });
const authority = await openRepositoryAuthority({
  statePath,
  runtime: { storageRoot, gitExecutable, gitVersion },
  gitIdentity,
  refUpdatePolicies: [{ name: "allow-all", revision: "f".repeat(64), async authorize() {} }],
});
console.log("READY");
const keepAlive = setInterval(() => {}, 60_000);
process.once("SIGTERM", () => {
  clearInterval(keepAlive);
  void authority.close().then(() => process.exit(0));
});
