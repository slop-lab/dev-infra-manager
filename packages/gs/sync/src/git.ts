import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { assertGitExecutableIdentity, type GitExecutableIdentity } from "@slop-lab/gs-repository";
import type { RepositoryTarget } from "@slop-lab/gs-repository-service";

const execute = promisify(execFile);

export interface GitRemoteAuthorization {
  authorize(url: URL): Promise<{ readonly headerName: string; readonly headerValue: string } | undefined>;
}

export interface GitSyncTransport {
  readonly allowLocalRemotes: boolean;
  run(input: {
    readonly target: RepositoryTarget;
    readonly args: readonly string[];
    readonly remoteUrl: string;
    readonly signal: AbortSignal;
    readonly remote?: boolean;
    readonly conflict?: boolean;
    readonly commit?: boolean;
  }): Promise<{ readonly output: string; readonly conflict: boolean }>;
}

export function createNodeGitSyncTransport(options: {
  readonly gitExecutable: string;
  readonly gitIdentity: GitExecutableIdentity;
  readonly allowLocalRemotes?: boolean;
  readonly remoteAuthorization?: GitRemoteAuthorization;
}): GitSyncTransport {
  return {
    allowLocalRemotes: options.allowLocalRemotes ?? false,
    async run(input) {
      await assertGitExecutableIdentity(options.gitExecutable, options.gitIdentity);
      input.signal.throwIfAborted();
      const env: NodeJS.ProcessEnv = {
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_NO_REPLACE_OBJECTS: "1",
        GIT_TERMINAL_PROMPT: "0",
        HOME: "/dev/null",
        LC_ALL: "C",
        PATH: "/usr/bin:/bin",
      };
      if (input.commit === true) Object.assign(env, {
        GIT_AUTHOR_NAME: "DIM upstream sync",
        GIT_AUTHOR_EMAIL: "sync@dim.invalid",
        GIT_COMMITTER_NAME: "DIM upstream sync",
        GIT_COMMITTER_EMAIL: "sync@dim.invalid",
      });
      if (input.remote === true && options.remoteAuthorization !== undefined) {
        const authorization = await options.remoteAuthorization.authorize(new URL(input.remoteUrl));
        if (authorization !== undefined) {
          env.GIT_CONFIG_COUNT = "1";
          env.GIT_CONFIG_KEY_0 = `http.${input.remoteUrl}.extraHeader`;
          env.GIT_CONFIG_VALUE_0 = `${authorization.headerName}: ${authorization.headerValue}`;
        }
      }
      try {
        const result = await execute(options.gitExecutable, [
          "--no-replace-objects", "--git-dir", input.target.repositoryPath,
          "-c", "core.hooksPath=/dev/null", "-c", "fetch.fsckObjects=true", "-c", "fsck.fullPathname=error",
          "-c", "credential.helper=", "-c", "http.followRedirects=false", "-c", "protocol.allow=never",
          "-c", "protocol.https.allow=always",
          ...(options.allowLocalRemotes === true ? ["-c", "protocol.file.allow=always"] : []),
          ...input.args,
        ], { env, signal: input.signal, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
        await assertGitExecutableIdentity(options.gitExecutable, options.gitIdentity);
        return { output: result.stdout, conflict: false };
      } catch (error) {
        if (input.conflict === true && error instanceof Error && "code" in error && error.code === 1
          && "stdout" in error && typeof error.stdout === "string") {
          await assertGitExecutableIdentity(options.gitExecutable, options.gitIdentity);
          return { output: error.stdout, conflict: true };
        }
        throw new GitSyncOperationError("Git synchronization failed; check remote availability, authorization and branch divergence");
      }
    },
  };
}

export class GitSyncOperationError extends Error {
  readonly name = "GitSyncOperationError";
}
