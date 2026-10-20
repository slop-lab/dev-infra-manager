import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { refUpdatePolicyExtension, type RefUpdatePolicy } from "../../../packages/control-plane/plugins/git-repositories/src/ref-update-policies.ts";
import { assertGitExecutableIdentity, type GitExecutableIdentity } from "../../../packages/control-plane/plugins/git-repositories/src/repository.ts";
const execute = promisify(execFile);
function parseOptions(options: unknown): { readonly paths: readonly string[] } {
  if (options === null || typeof options !== "object" || Array.isArray(options) || Object.keys(options).length !== 1 || !("paths" in options) || !Array.isArray(options.paths)
    || options.paths.length === 0 || options.paths.length > 32 || options.paths.some((path: unknown) => typeof path !== "string" || Buffer.byteLength(path) > 1024 || Buffer.from(path).toString("utf8") !== path || path.startsWith("/") || /[\x00-\x1f\x7f]/.test(path) || path.split("/").some((part) => part === "" || part === "." || part === "..")) || new Set(options.paths).size !== options.paths.length) {
    throw new Error("retain-files requires 1–32 unique normalized relative paths");
  }
  return { paths: options.paths as string[] };
}
/** This check inspects immutable Git objects and never executes project code. */
export async function assertRetainedFiles(input: {
  readonly gitExecutable: string;
  readonly gitIdentity: GitExecutableIdentity;
  readonly repository: string;
  readonly candidateTree: string;
  readonly options: unknown;
}): Promise<void> {
  const { paths } = parseOptions(input.options);
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(input.candidateTree)) throw new Error("retain-files requires an exact candidate tree");
  for (const path of paths) {
    await assertGitExecutableIdentity(input.gitExecutable, input.gitIdentity);
    const { stdout } = await execute(input.gitExecutable, ["--no-replace-objects", "--literal-pathspecs", "--git-dir", input.repository, "ls-tree", "-z", "--full-tree", input.candidateTree, "--", path], {
      env: { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_NO_REPLACE_OBJECTS: "1", HOME: "/dev/null", LC_ALL: "C" }, maxBuffer: 4096, timeout: 10_000, encoding: "buffer"
    });
    const entry = /^(100644|100755) blob ([0-9a-f]{40}|[0-9a-f]{64})\t/.exec(stdout.toString("utf8"));
    if (entry === null || !stdout.subarray(Buffer.byteLength(entry[0])).equals(Buffer.from(`${path}\0`))) throw new Error(`retain-files denies candidate without regular file '${path}'`);
  }
}
export async function createRetainFilesRefPolicy(): Promise<RefUpdatePolicy> {
  return {
    name: "retain-files",
    revision: createHash("sha256").update(await readFile(new URL(import.meta.url))).digest("hex"),
    validate(options) { parseOptions(options); },
    async check({ context, target, change, options }) {
      await assertRetainedFiles({ gitExecutable: context.runtime.gitExecutable, gitIdentity: context.runtime.gitIdentity, repository: target.repository, candidateTree: change.candidateTree, options });
    }
  };
}
export async function retainFilesRefPolicyExtension() { return refUpdatePolicyExtension(await createRetainFilesRefPolicy()); }
