import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type GitReadGate = {
  readonly executable: string;
  arm(): Promise<void>;
  release(): Promise<void>;
};

export async function createGitReadGate(root: string, gitExecutable: string): Promise<GitReadGate> {
  const executable = join(root, "git");
  const arm = join(root, "candidate-read-arm");
  const entered = join(root, "candidate-read-entered");
  const release = join(root, "candidate-read-release");
  await writeFile(executable, `#!/bin/sh
set -eu
if [ -e ${JSON.stringify(arm)} ]; then
  case " $* " in
    *" cat-file blob "*)
      : > ${JSON.stringify(entered)}
      while [ ! -e ${JSON.stringify(release)} ]; do sleep 0.01; done
      ;;
  esac
fi
exec ${gitExecutable} "$@"
`, { mode: 0o700 });
  return {
    executable,
    async arm() {
      await Promise.all([rm(entered, { force: true }), rm(release, { force: true })]);
      await writeFile(arm, "armed\n");
    },
    async release() {
      await writeFile(release, "released\n");
    }
  };
}
