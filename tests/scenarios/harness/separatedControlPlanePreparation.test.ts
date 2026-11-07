import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

const helpers = resolve(import.meta.dirname, "../../../scripts/checks/lib");
const exists = async (file: string) => access(file).then(() => true, () => false);

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "dim-cp-preparation-")), ssh = join(root, "ssh.bash");
  await writeFile(ssh, `#!/bin/bash
set -euo pipefail
if [[ "$1" == bash ]]; then
  cat >/dev/null
  : >"$DIM_TEST_ROOT/install-started"
  until [[ -e "$DIM_TEST_ROOT/release" ]]; do sleep 0.02; done
  printf 'retained installer diagnostic\\n'
  exit "$(cat "$DIM_TEST_ROOT/release")"
fi
: >"$DIM_TEST_ROOT/service-started"
exec sleep 30
`, { mode: 0o700 });
  const script = `set -euo pipefail
source "$1/check-output.bash"
source "$1/examples-control-plane.bash"
BOOTSTRAP_SSH=(bash "$2")
BOOTSTRAP_EVIDENCE_ROOT="$DIM_TEST_ROOT"
EXAMPLES_CP_SSH_PID=""
trap 'if [[ -n "$EXAMPLES_CP_SSH_PID" ]]; then kill "$EXAMPLES_CP_SSH_PID" 2>/dev/null || true; wait "$EXAMPLES_CP_SSH_PID" 2>/dev/null || true; fi' EXIT
trap 'exit 130' INT TERM
check_output_init "$DIM_TEST_ROOT/stages"
# Call in a conditional deliberately: failed installation must stop the helper
# even when Bash disables implicit errexit inside a function.
if examples_prepare_and_start_control_plane; then
  until [[ -e "$DIM_TEST_ROOT/done" ]]; do sleep 0.02; done
else exit "$?"; fi
`;
  const child = spawn("bash", ["-c", script, "test", helpers, ssh], { env: { ...process.env, DIM_TEST_ROOT: root }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.resume(); child.stderr.resume();
  const closed = once(child, "close");
  return { root, child, closed, async cleanup() { await writeFile(join(root, "release"), "23"); await writeFile(join(root, "done"), ""); if (child.exitCode === null) child.kill("SIGTERM"); await closed; await rm(root, { recursive: true, force: true }); } };
}

it("defers service startup until the foreground installation really completes", async () => {
  const f = await fixture();
  try {
    await expect.poll(() => exists(join(f.root, "install-started"))).toBe(true);
    expect(await exists(join(f.root, "service-started"))).toBe(false);
    await writeFile(join(f.root, "release"), "0");
    await expect.poll(() => exists(join(f.root, "service-started"))).toBe(true);
    await writeFile(join(f.root, "done"), "");
    expect((await f.closed)[0]).toBe(0);
  } finally { await f.cleanup(); }
});

it("retains a failed install's original exit and diagnostic without starting a service", async () => {
  const f = await fixture();
  try {
    await expect.poll(() => exists(join(f.root, "install-started"))).toBe(true);
    await writeFile(join(f.root, "release"), "23");
    expect((await f.closed)[0]).toBe(23);
    expect(await exists(join(f.root, "service-started"))).toBe(false);
    const { readdir } = await import("node:fs/promises");
    const [run] = await readdir(join(f.root, "stages"));
    expect(await readFile(join(f.root, "stages", run!, "01-control-plane-install.log"), "utf8")).toContain("retained installer diagnostic");
    expect(await readFile(join(f.root, "stages", run!, "stages.jsonl"), "utf8")).toContain('"exitCode":23');
  } finally { await f.cleanup(); }
});
