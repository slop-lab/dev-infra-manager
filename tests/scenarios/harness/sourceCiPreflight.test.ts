import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";

const repository = resolve(import.meta.dirname, "../../..");
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "dim-source-ci-preflight-")); roots.push(root);
  const source = join(root, "source"), tools = join(root, "tools"), home = join(root, "home"), log = join(root, "commands.log");
  await Promise.all([mkdir(join(source, "scripts/ci"), { recursive: true }), mkdir(join(source, "scripts/checks/source-gate"), { recursive: true }), mkdir(tools), mkdir(home)]);
  for (const file of ["scripts/ci/source.bash", "scripts/checks/source-gate/install-just.bash"]) await copyFile(join(repository, file), join(source, file));
  const staged = join(root, "run/dim/job/script");
  await mkdir(join(root, "run/dim/job"), { recursive: true });
  await copyFile(join(repository, "scripts/ci/source.bash"), staged);
  await writeFile(join(source, "reviewed.txt"), "exact candidate bytes\n");
  await writeFile(join(source, ".gitignore"), "ignored.txt\n");
  await writeFile(join(source, "ignored.txt"), "tracked upstream input\n");
  await writeFile(join(tools, "pnpm"), `#!/bin/bash
set -euo pipefail
if [[ "$*" == --version ]]; then printf '10.13.1\\n'; exit 0; fi
test "$(just --version)" = 'just 1.43.1'
git -C "$PWD" rev-parse --verify HEAD >/dev/null
test "$(git config --get dim.fixture)" = preserved
if [[ -n "\${DIM_SOURCE_PREFLIGHT_FOREIGN:-}" ]]; then
  ! git -C "$DIM_SOURCE_PREFLIGHT_FOREIGN" rev-parse --git-dir 2>/dev/null
fi
printf '%s\\n' "$*" >>"$DIM_SOURCE_PREFLIGHT_LOG"
`, { mode: 0o755 });
  await writeFile(join(tools, "just"), "#!/bin/sh\nprintf 'just 1.43.1\\n'\n", { mode: 0o755 });
  return { root, source, tools, home, log, staged };
}
function run(f: Awaited<ReturnType<typeof fixture>>, environment: NodeJS.ProcessEnv = {}) {
  return spawnSync("/bin/bash", [f.staged], { cwd: f.source, encoding: "utf8", env: {
    PATH: `${f.tools}:/usr/local/bin:/usr/bin:/bin`, HOME: f.home, DIM_SOURCE_PREFLIGHT_LOG: f.log,
    GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "dim.fixture", GIT_CONFIG_VALUE_0: "preserved", ...environment
  } });
}
const commands = "install --frozen-lockfile\nrun workspace:build\nrun workspace:check\nrun workspace:test\n";

it("creates only a job-local Git snapshot before source checks and preserves an existing worktree", async () => {
  const f = await fixture();
  const first = run(f); expect(first.status, first.stderr).toBe(0);
  expect(await readFile(f.log, "utf8")).toBe(commands);
  expect(spawnSync("git", ["-C", f.source, "ls-files", "--error-unmatch", "ignored.txt"], { encoding: "utf8" }).status).toBe(0);
  const head = spawnSync("git", ["-C", f.source, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout;
  await writeFile(join(f.source, "reviewed.txt"), "uncommitted developer change\n");
  const second = run(f); expect(second.status, second.stderr).toBe(0);
  expect(spawnSync("git", ["-C", f.source, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout).toBe(head);
  expect(spawnSync("git", ["-C", f.source, "status", "--porcelain"], { encoding: "utf8" }).stdout).toContain("reviewed.txt");
});

it.each(["1+1", "01", "64", "-1"])("rejects a noncanonical or out-of-bound Git config count %s before snapshot writes", async (count) => {
  const f = await fixture(), result = run(f, { GIT_CONFIG_COUNT: count });
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("configuration count");
  await expect(readFile(join(f.source, ".git/HEAD"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("rejects unsupported Just architecture and bad downloaded bytes before changing a tool", async () => {
  const f = await fixture(), destination = join(f.home, "bin"); await mkdir(destination);
  await writeFile(join(destination, "just"), "preserve");
  const installer = join(f.source, "scripts/checks/source-gate/install-just.bash");
  const unsupported = spawnSync("bash", [installer, destination, "unsupported"], { encoding: "utf8" });
  expect(unsupported.status).toBe(2);
  await writeFile(join(f.tools, "curl"), "#!/bin/bash\nwhile (( $# )); do if [[ $1 == --output ]]; then printf bad >\"$2\"; exit 0; fi; shift; done\nexit 1\n", { mode: 0o755 });
  const bad = spawnSync("bash", [installer, destination, "amd64"], { encoding: "utf8", env: { PATH: `${f.tools}:/usr/bin:/bin` } });
  expect(bad.status).not.toBe(0);
  expect(await readFile(join(destination, "just"), "utf8")).toBe("preserve");
});

it.skipIf(!process.env.DIM_TEST_SOURCE_CI_IMAGE)("bootstraps real pinned Just and Git metadata in a fresh Node26 container", { timeout: 180_000 }, async () => {
  const f = await fixture(), image = process.env.DIM_TEST_SOURCE_CI_IMAGE!;
  expect(image).toMatch(/@sha256:[0-9a-f]{64}$/);
  await rm(join(f.tools, "just"));
  const foreign = join(f.root, "foreign"); await mkdir(foreign);
  expect(spawnSync("git", ["-C", foreign, "init", "--quiet"], { encoding: "utf8" }).status).toBe(0);
  const result = spawnSync("docker", ["run", "--rm", "--pull", "never", "--read-only", "--user", "0:0",
    "--tmpfs", "/tmp:rw,exec,mode=1777", "--mount", `type=bind,source=${f.root},target=/fixture`,
    "--mount", `type=bind,source=${f.source},target=/workspace/main`,
    "--mount", `type=bind,source=${f.staged},target=/run/dim/job/script,readonly`, "--workdir", "/workspace/main",
    "--env", "HOME=/tmp/job-home", "--env", "PATH=/fixture/tools:/usr/local/bin:/usr/bin:/bin", "--env", "DIM_SOURCE_PREFLIGHT_LOG=/fixture/commands.log",
    "--env", "DIM_SOURCE_PREFLIGHT_FOREIGN=/fixture/foreign",
    "--env", "GIT_CONFIG_COUNT=1", "--env", "GIT_CONFIG_KEY_0=dim.fixture", "--env", "GIT_CONFIG_VALUE_0=preserved",
    "--entrypoint", "/bin/bash", image, "-eu", "-c",
    String.raw`[[ $(node --version) == v26.* ]]
test "$(pwd -P)" = /workspace/main
test "$(id -u)" = 0
test "$(stat -c %u .)" = 1000
! test -w /run/dim/job/script
! command -v just
test ! -e .git
trap 'rm -rf /workspace/main/.git' EXIT
mkdir -p "$HOME"
bash --noprofile --norc /run/dim/job/script
test "$("$HOME/.local/dim-ci-tools/bin/just" --version)" = 'just 1.43.1'
before=$(git -c safe.directory=/workspace/main rev-parse HEAD)
printf modified > reviewed.txt
bash --noprofile --norc /run/dim/job/script
test "$(git -c safe.directory=/workspace/main rev-parse HEAD)" = "$before"
test -n "$(git -c safe.directory=/workspace/main status --porcelain)"`
  ], { encoding: "utf8", timeout: 170_000 });
  expect(result.status, JSON.stringify({ error: result.error?.message, signal: result.signal, stderr: result.stderr })).toBe(0);
  expect(await readFile(f.log, "utf8")).toBe(commands.repeat(2));
});
