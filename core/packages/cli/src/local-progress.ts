import { Writable } from "node:stream";
import { UserError } from "@slop-lab/dim-core";
import { createAdminStreamProgress, type CliProgress } from "./cli-progress.js";

export type LocalProgressContext = {
  readonly signal: AbortSignal;
  readonly reportProgress: (stage: string) => void;
  readonly stdout?: Writable;
  readonly stderr?: Writable;
};

export async function withLocalProgress<T>(
  operation: string,
  action: (context: LocalProgressContext) => Promise<T>
): Promise<T> {
  const progress = createAdminStreamProgress(operation);
  const abort = new AbortController();
  const cancel = (): void => {
    progress.stop();
    abort.abort(new UserError(`${operation} cancelled`));
  };
  process.once("SIGINT", cancel);
  try {
    return await action({
      signal: abort.signal,
      reportProgress: (stage) => progress.update(stage),
      ...(process.stderr.isTTY === true ? {
        stdout: activityStream(progress, process.stdout),
        stderr: activityStream(progress, process.stderr)
      } : {})
    });
  } finally {
    progress.stop();
    process.off("SIGINT", cancel);
  }
}

function activityStream(progress: CliProgress, target: NodeJS.WriteStream): Writable {
  return new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      progress.activity();
      target.write(chunk, callback);
    }
  });
}
