import { spawn } from "node:child_process";
import { lstat, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const ASKPASS = `#!/bin/sh
case "$1" in
  Username*) printf '%s\\n' "$DIM_NATIVE_GIT_READER_USERNAME" ;;
  Password*) printf '%s\\n' "$DIM_NATIVE_GIT_READER_PASSWORD" ;;
  *) exit 1 ;;
esac
`;

export type GitProcessOptions = {
  readonly executable: string;
  readonly temporaryRoot: string;
  readonly objectFormat: GitObjectFormat;
  readonly username: string;
  readonly password: string;
  readonly timeoutMilliseconds: number;
};

export type GitObjectFormat = "sha1" | "sha256";

export type DisposableGit = {
  readonly repository: string;
  readonly objectFormat: GitObjectFormat;
  run(args: readonly string[], maximumOutputBytes: number, signal: AbortSignal): Promise<Buffer>;
  runAuthenticated(args: readonly string[], maximumOutputBytes: number, signal: AbortSignal): Promise<Buffer>;
  close(): Promise<void>;
};

type GitInvocation = {
  readonly executable: string;
  readonly args: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
  readonly maximumOutputBytes: number;
  readonly timeoutMilliseconds: number;
  readonly signal: AbortSignal;
};

export async function openDisposableGit(options: GitProcessOptions, signal: AbortSignal): Promise<DisposableGit> {
  const rootMetadata = await lstat(options.temporaryRoot);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()
    || rootMetadata.uid !== effectiveUserId() || (rootMetadata.mode & 0o077) !== 0) {
    throw new NativeGitProcessError("native Git temporary root is not private");
  }
  const root = await mkdtemp(join(options.temporaryRoot, "candidate-"));
  const repository = join(root, "objects.git");
  const askpass = join(root, "askpass");
  await writeFile(askpass, ASKPASS, { encoding: "utf8", flag: "wx", mode: 0o700 });
  const environment = gitEnvironment();
  const authenticatedEnvironment = {
    ...environment,
    GIT_ASKPASS: askpass,
    DIM_NATIVE_GIT_READER_USERNAME: options.username,
    DIM_NATIVE_GIT_READER_PASSWORD: options.password
  };
  const operation = {
    repository,
    objectFormat: options.objectFormat,
    run: (args: readonly string[], maximumOutputBytes: number, operationSignal: AbortSignal) =>
      runGit({
        executable: options.executable, args, environment, maximumOutputBytes,
        timeoutMilliseconds: options.timeoutMilliseconds, signal: operationSignal
      }),
    runAuthenticated: (args: readonly string[], maximumOutputBytes: number, operationSignal: AbortSignal) =>
      runGit({
        executable: options.executable, args, environment: authenticatedEnvironment, maximumOutputBytes,
        timeoutMilliseconds: options.timeoutMilliseconds, signal: operationSignal
      }),
    close: () => rm(root, { recursive: true, force: true })
  } satisfies DisposableGit;
  try {
    await operation.run([
      "init", "--bare", "--quiet", `--object-format=${options.objectFormat}`, repository
    ], 4096, signal);
    return operation;
  } catch (error) {
    await operation.close();
    throw error;
  }
}

function gitEnvironment(): NodeJS.ProcessEnv {
  const settings = [
    ["credential.helper", ""],
    ["credential.useHttpPath", "true"],
    ["http.followRedirects", "false"],
    ["protocol.allow", "never"],
    ["protocol.http.allow", "always"],
    ["protocol.https.allow", "always"],
    ["fetch.fsckObjects", "true"],
    ["transfer.fsckObjects", "true"],
    ["core.hooksPath", "/dev/null"],
    ["http.maxRequests", "1"],
    ["http.lowSpeedLimit", "1"],
    ["http.lowSpeedTime", "10"],
    ["protocol.version", "2"]
  ] as const;
  return {
    LC_ALL: "C",
    HOME: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_PROTOCOL_FROM_USER: "0",
    GIT_CONFIG_COUNT: String(settings.length),
    ...Object.fromEntries(settings.flatMap(([key, value], index) => [
      [`GIT_CONFIG_KEY_${index}`, key],
      [`GIT_CONFIG_VALUE_${index}`, value]
    ]))
  };
}

function runGit(input: GitInvocation): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (input.signal.aborted) {
      reject(new NativeGitProcessError("native Git operation was aborted"));
      return;
    }
    const child = spawn(input.executable, input.args, {
      detached: true, env: input.environment, stdio: ["ignore", "pipe", "pipe"]
    });
    const output: Buffer[] = [];
    let outputBytes = 0;
    let errorBytes = 0;
    let settled = false;
    let failure: string | undefined;
    const stop = (): void => {
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) child.kill("SIGKILL");
        }
      }
    };
    const terminate = (message: string): void => {
      if (settled || failure !== undefined) return;
      failure = message;
      stop();
    };
    const aborted = (): void => terminate("native Git operation was aborted");
    const timer = setTimeout(() => terminate("native Git operation timed out"), input.timeoutMilliseconds);
    timer.unref();
    input.signal.addEventListener("abort", aborted, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > input.maximumOutputBytes) terminate("native Git output exceeded its limit");
      else output.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      errorBytes += chunk.length;
      if (errorBytes > 64 * 1024) terminate("native Git error output exceeded its limit");
    });
    child.on("error", () => terminate("native Git process could not start"));
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal.removeEventListener("abort", aborted);
      if (failure !== undefined) reject(new NativeGitProcessError(failure));
      else if (code === 0) resolve(Buffer.concat(output));
      else reject(new NativeGitProcessError("native Git operation failed"));
    });
  });
}

export function effectiveUserId(): number {
  const userId = process.geteuid?.();
  if (userId === undefined) throw new NativeGitProcessError("native Git candidate reads require Linux user identity");
  return userId;
}

export class NativeGitProcessError extends Error {
  readonly name = "NativeGitProcessError";
}
