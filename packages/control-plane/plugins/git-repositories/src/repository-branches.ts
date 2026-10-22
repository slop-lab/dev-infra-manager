import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { nativeRepositoryBranches, nativeRepositoryDefaultRef } from "./native-imported-root-policy.js";
import { readEffectiveRepositoryPolicy } from "./repository-policy-state.js";
import { assertRepositoryBranchBaselines } from "./repository-branch-state.js";
import { readNativeProjectRootImportsFromDatabase } from "./native-project-root-import-transitions.js";
import { readNativeProjectRootCurrentHeadFromDatabase, readRepositoryRefTransitions, RepositoryRefStateError } from "./repository-ref-state.js";
import { assertGitExecutableIdentity, type GitExecutableIdentity } from "./repository.js";
const execute = promisify(execFile);
type BranchRuntime = { readonly database: string; readonly stateDirectory: string; readonly gitExecutable: string; readonly gitIdentity: GitExecutableIdentity };
/** Called inside the owning service mutation queue, or during startup before requests are served.
 * The durable baseline is written before Git creation; retries recover only that exact snapshot. */
export async function ensureConfiguredRepositoryBranches(runtime: BranchRuntime, projectId: string, repositoryId: string): Promise<void> {
  const imported = readNativeProjectRootImportsFromDatabase(runtime.database).find((entry) => entry.projectId === projectId && entry.repositoryId === repositoryId);
  if (imported?.phase !== "repository-imported") return;
  const { policy } = readEffectiveRepositoryPolicy(runtime.database, projectId, repositoryId);
  const seed = readNativeProjectRootCurrentHeadFromDatabase(runtime.database, projectId, repositoryId, imported.protectedRef);
  const repository = join(runtime.stateDirectory, projectId, `${repositoryId}.git`);
  const run = async (args: readonly string[]) => {
    await assertGitExecutableIdentity(runtime.gitExecutable, runtime.gitIdentity);
    const result = await execute(runtime.gitExecutable, ["--no-replace-objects", "--git-dir", repository, ...args], { env: { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_NO_REPLACE_OBJECTS: "1", HOME: "/dev/null", LC_ALL: "C" }, maxBuffer: 64 * 1024, timeout: 30_000 });
    await assertGitExecutableIdentity(runtime.gitExecutable, runtime.gitIdentity);
    return result.stdout.trim();
  };
  for (const ref of Object.keys(nativeRepositoryBranches(policy))) {
    if (ref === imported.protectedRef) continue;
    const database = new DatabaseSync(runtime.database, { defensive: true });
    let existed: boolean;
    try {
      const prior = assertRepositoryBranchBaselines(database).find((entry) => entry.project_id === projectId && entry.repository_id === repositoryId && entry.protected_ref === ref);
      existed = prior !== undefined;
      if (!existed) {
        // An existing unrecorded head is never adopted, even when its object happens to match the seed.
        if ((await run(["for-each-ref", "--format=%(refname)", ref])).split("\n").includes(ref)) throw new RepositoryRefStateError("configured repository branch already exists without an authoritative baseline");
        database.exec("PRAGMA synchronous=FULL");
        const sourceSequence = readRepositoryRefTransitions(database).filter(({ transition, finalized }) => finalized && transition.projectId === projectId && transition.repositoryId === repositoryId && transition.protectedRef === imported.protectedRef).at(-1)?.transition.sequence ?? 0;
        database.prepare("INSERT INTO repository_branch_baseline VALUES(?,?,?,?,?,?,?)").run(projectId, repositoryId, ref, imported.importNonce, sourceSequence, seed.commit, seed.tree);
      }
    } finally { database.close(); }
    const head = readNativeProjectRootCurrentHeadFromDatabase(runtime.database, projectId, repositoryId, ref);
    const refs = await run(["for-each-ref", "--format=%(refname) %(objectname)", ref]);
    const actual = refs.split("\n").find((line) => line.startsWith(`${ref} `))?.slice(ref.length + 1);
    if (actual === undefined) {
      const database = new DatabaseSync(runtime.database, { readOnly: true });
      let promoted: boolean;
      try { promoted = database.prepare("SELECT 1 FROM repository_ref_transition WHERE project_id=? AND repository_id=? AND json_extract(record_json,'$.protectedRef')=?").get(projectId, repositoryId, ref) !== undefined; }
      finally { database.close(); }
      if (promoted) throw new RepositoryRefStateError("authoritative repository branch disappeared after promotion");
      await run(["update-ref", ref, head.commit, "0".repeat(head.commit.length)]);
    } else if (actual !== head.commit) throw new RepositoryRefStateError("configured repository branch conflicts with its authoritative baseline");
  }
  const defaultRef = nativeRepositoryDefaultRef(policy);
  // HEAD is service-owned metadata, updated only after every configured baseline is proven.
  await run(["symbolic-ref", "HEAD", defaultRef]);
}
export async function recoverConfiguredRepositoryBranches(runtime: BranchRuntime): Promise<void> {
  for (const imported of readNativeProjectRootImportsFromDatabase(runtime.database)) {
    if (imported.phase === "repository-imported") await ensureConfiguredRepositoryBranches(runtime, imported.projectId, imported.repositoryId);
  }
}
