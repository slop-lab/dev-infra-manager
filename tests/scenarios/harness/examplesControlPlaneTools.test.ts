import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

const repository = resolve(import.meta.dirname, "../../..");
it.each(["cold", "cached"] as const)("passes an explicit %s CP-tools mode through SSH command reconstruction", async mode => {
  const root = await mkdtemp(join(tmpdir(), "dim-cp-tools-ssh-"));
  try {
    const source = await readFile(join(repository, "scripts/checks/lib/examples-separated-vms.bash"), "utf8");
    const start = source.indexOf("  printf '[examples] phase=control-plane-tools");
    const end = source.indexOf("<<'REMOTE'", start);
    expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
    const invocation = source.slice(start, end);
    const ssh = join(root, "ssh-command-reconstruction");
    // OpenSSH executes one remote shell command, rather than preserving argv.
    await writeFile(ssh, '#!/bin/bash\nexec /bin/bash -c "$*"\n', { mode: 0o700 });
    const script = `set -euo pipefail
BOOTSTRAP_SSH=("$1")
CHECK_OUTPUT_ROOT="$2"
if [[ "$3" == cached ]]; then BOOTSTRAP_BASELINE_DIRECTORY="$2"; else unset BOOTSTRAP_BASELINE_DIRECTORY; fi
check_output_run() { shift; "$@"; }
fixture() {
${invocation}<<'REMOTE'
set -euo pipefail
[[ "$#" == 1 ]]
printf 'mode=%s\\n' "$1"
REMOTE
}
fixture
`;
    const result = spawnSync("bash", ["-c", script, "cp-tools-fixture", ssh, root, mode], { encoding: "utf8", timeout: 10_000 });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n").at(-1)).toBe(`mode=${mode}`);
  } finally { await rm(root, { recursive: true, force: true }); }
});
