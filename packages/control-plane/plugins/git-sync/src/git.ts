import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { assertGitExecutableIdentity, type RepositoryRuntime } from "@slop-lab/dim-control-plane-plugin-git-repositories/plugin-api";
import type { GitSyncConfiguration } from "./config.js";

const execute = promisify(execFile);
export class GitSyncOperationError extends Error { readonly name = "GitSyncOperationError"; }
/** Never inherit agent/user Git configuration, helpers, proxies, hooks, or process secrets. */
export function gitRunner(runtime: RepositoryRuntime, repository: string, config: GitSyncConfiguration, signal: AbortSignal, remoteURL: string) {
  return async (args: readonly string[], options: { readonly remote?: boolean; readonly conflict?: boolean; readonly commit?: boolean } = {}) => {
    await assertGitExecutableIdentity(runtime.gitExecutable, runtime.gitIdentity);
    signal.throwIfAborted();
    const env: NodeJS.ProcessEnv = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_NO_REPLACE_OBJECTS: "1",
      GIT_TERMINAL_PROMPT: "0", HOME: "/dev/null", LC_ALL: "C", PATH: "/usr/bin:/bin" };
    if (options.commit) Object.assign(env, { GIT_AUTHOR_NAME: "DIM upstream sync", GIT_AUTHOR_EMAIL: "sync@dim.invalid",
      GIT_COMMITTER_NAME: "DIM upstream sync", GIT_COMMITTER_EMAIL: "sync@dim.invalid" });
    if (options.remote && config.credential && new URL(remoteURL).protocol === "https:") {
      // Environment-scoped Git config keeps the credential out of command arguments and persistent repository config.
      env.GIT_CONFIG_COUNT = "1"; env.GIT_CONFIG_KEY_0 = `http.${remoteURL}.extraHeader`;
      env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${Buffer.from(`${config.credential.username}:${config.credential.password}`).toString("base64")}`;
    }
    try {
      const result = await execute(runtime.gitExecutable, ["--no-replace-objects", "--git-dir", repository,
        "-c", "core.hooksPath=/dev/null", "-c", "fetch.fsckObjects=true", "-c", "fsck.fullPathname=error", "-c", "credential.helper=", "-c", "http.followRedirects=false",
        "-c", "protocol.allow=never", "-c", "protocol.https.allow=always",
        ...(config.allowLocalRemotes ? ["-c", "protocol.file.allow=always"] : []), ...args],
      { env, signal, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
      await assertGitExecutableIdentity(runtime.gitExecutable, runtime.gitIdentity);
      return { output: result.stdout, conflict: false };
    } catch (error) {
      if (options.conflict && error instanceof Error && "code" in error && error.code === 1 && "stdout" in error && typeof error.stdout === "string") {
        await assertGitExecutableIdentity(runtime.gitExecutable, runtime.gitIdentity);
        return { output: error.stdout, conflict: true };
      }
      // Git stderr can contain configured credentials or server response bodies. Never return it over the API.
      throw new GitSyncOperationError("Git synchronization failed; check remote availability, authorization and branch divergence");
    }
  };
}
