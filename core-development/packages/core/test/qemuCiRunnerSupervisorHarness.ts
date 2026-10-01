import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QEMU_CI_SUPERVISOR_SCRIPT } from "../../../../core/packages/core/src/qemuCiRunnerSupervisorAssets.js";

export interface SupervisorRunResult {
  readonly code: number;
  readonly durationMs: number;
  readonly stderr: string;
  readonly log: readonly string[];
  readonly remainingRunDirectories: readonly string[];
}

export interface SupervisorHarness {
  readonly root: string;
  readonly registrationToken: string;
  readonly run: (extra?: Readonly<Record<string, string>>) => Promise<SupervisorRunResult>;
  readonly remainingRunDirectories: () => Promise<readonly string[]>;
  readonly cleanup: () => Promise<void>;
}

export async function createSupervisorHarness(): Promise<SupervisorHarness> {
  const root = await mkdtemp(join(tmpdir(), "dim-qemu-supervisor-"));
  const bin = join(root, "bin");
  const dataRoot = join(root, "data");
  const scriptPath = join(root, "supervise.bash");
  const preparePath = join(root, "prepare-image");
  const runnerPath = join(root, "gitea-runner");
  const registrationToken = "reusable-registration-token-fixture";
  const children = new Set<ChildProcess>();
  await mkdir(bin);
  await Promise.all([
    writeExecutable(join(bin, "cloud-localds"), fakeCloudLocalds),
    writeExecutable(join(bin, "curl"), fakeCurl),
    writeExecutable(join(bin, "qemu-img"), fakeQemuImg),
    writeExecutable(join(bin, "qemu-system-x86_64"), fakeQemu),
    writeExecutable(join(bin, "python3"), fakePython),
    writeExecutable(join(bin, "scp"), fakeScp),
    writeExecutable(join(bin, "socat"), fakeSocat),
    writeExecutable(join(bin, "ssh"), fakeSsh),
    writeExecutable(join(bin, "ssh-keygen"), fakeSshKeygen),
    writeExecutable(join(bin, "ssh-keyscan"), fakeSshKeyscan),
    writeExecutable(preparePath, fakePrepare),
    writeExecutable(runnerPath, fakeRunner)
  ]);
  await writeFile(scriptPath, QEMU_CI_SUPERVISOR_SCRIPT
    .replace("data_root=/var/lib/dim-qemu-ci", `data_root=${dataRoot}`)
    .replace("/usr/local/bin/dim-qemu-ci-prepare-image", preparePath)
    .replaceAll("/usr/local/bin/gitea-runner", runnerPath));
  await chmod(scriptPath, 0o700);

  const run = async (extra: Readonly<Record<string, string>> = {}): Promise<SupervisorRunResult> => {
    const started = Date.now();
    const child = spawn("bash", [scriptPath], {
      detached: true,
      env: {
        PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
        FAKE_ROOT: root,
        GITEA_INSTANCE_URL: "https://gitea.example.test",
        GITEA_RUNNER_REGISTRATION_TOKEN: registrationToken,
        GITEA_RUNNER_NAME: "runner-fixture",
        DIM_QEMU_CI_JOB_IMAGE: `example.test/job@sha256:${"a".repeat(64)}`,
        DIM_QEMU_CI_LABELS: "dim-qemu",
        DIM_CI_REGISTRY_CACHE_UPSTREAM: "cache:5000",
        DIM_QEMU_CI_JOB_TIMEOUT_SECONDS: "1",
        ...extra
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    children.add(child);
    child.once("close", () => children.delete(child));
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    const watchdog = setTimeout(() => {
      if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
    }, 4_000);
    const code = await new Promise<number>((resolve) => child.once("close", (status, signal) => {
      clearTimeout(watchdog);
      resolve(status ?? (signal === "SIGTERM" ? 143 : 128));
    }));
    const log = await readLines(join(root, "tools.log"));
    const remainingRunDirectories = await readDirectory(join(dataRoot, "runs"));
    return { code, durationMs: Date.now() - started, stderr, log, remainingRunDirectories };
  };
  const cleanup = async (): Promise<void> => {
    for (const child of children) child.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  };
  return {
    root,
    registrationToken,
    run,
    remainingRunDirectories: () => readDirectory(join(dataRoot, "runs")),
    cleanup
  };
}

async function writeExecutable(path: string, content: string): Promise<void> {
  await writeFile(path, content, { mode: 0o700 });
}

async function readLines(path: string): Promise<readonly string[]> {
  try {
    return (await readFile(path, "utf8")).trim().split("\n").filter(Boolean);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

async function readDirectory(path: string): Promise<readonly string[]> {
  try {
    return await readdir(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

const fakePrepare = "#!/usr/bin/env bash\nprintf '%s\\n' /tmp/runner-project.qcow2\n";
const fakeCloudLocalds = `#!/usr/bin/env bash
mirror="$(/usr/bin/grep -oE '10[.]0[.]2[.]2:[0-9]+' "$2" | /usr/bin/sort -u | /usr/bin/head -n 1)"
printf 'cloud-localds relay=%s seed=%s\n' "$mirror" "$1" >>"$FAKE_ROOT/tools.log"
touch "$1"
`;
const fakeCurl = `#!/usr/bin/env bash
printf 'curl %s\n' "$*" >>"$FAKE_ROOT/tools.log"
exit 0
`;
const fakeQemuImg = `#!/usr/bin/env bash
for argument in "$@"; do
  [[ "$argument" != *.qcow2 ]] || touch "$argument"
done
`;
const fakeSshKeyscan = `#!/usr/bin/env bash
port=""
while [[ "$#" -gt 0 ]]; do
  [[ "$1" != -p ]] || { port="$2"; shift; }
  shift
done
printf 'ssh-keyscan port=%s\n' "$port" >>"$FAKE_ROOT/tools.log"
printf '[127.0.0.1]:%s ssh-ed25519 AAAAC3fixture\n' "$port"
`;
const fakeSocat = `#!/usr/bin/env bash
printf 'socat token=%s %s\n' "\${GITEA_RUNNER_REGISTRATION_TOKEN:+present}" "$*" >>"$FAKE_ROOT/tools.log"
trap 'printf "socat-terminated\\n" >>"$FAKE_ROOT/tools.log"; exit 0' TERM
while true; do :; done
`;
const fakeQemu = `#!/usr/bin/env bash
port="$(printf '%s\n' "$*" | /usr/bin/grep -oE 'hostfwd=tcp:127[.]0[.]0[.]1:[0-9]+' | /usr/bin/cut -d: -f3)"
printf 'qemu-start token=%s ssh_port=%s %s\n' "\${GITEA_RUNNER_REGISTRATION_TOKEN:+present}" "$port" "$*" >>"$FAKE_ROOT/tools.log"
if [[ "\${FAKE_QEMU_IGNORE_TERM:-}" == 1 ]]; then
  trap 'printf "qemu-term-ignored\\n" >>"$FAKE_ROOT/tools.log"' TERM
else
  trap 'printf "qemu-terminated\\n" >>"$FAKE_ROOT/tools.log"; exit 0' TERM
fi
while [[ ! -f "$FAKE_ROOT/guest-finished-$port" ]]; do :; done
printf 'qemu-exited\n' >>"$FAKE_ROOT/tools.log"
`;
const fakeSshKeygen = `#!/usr/bin/env bash
path=""
for ((index=1; index <= $#; index+=1)); do
  [[ "\${!index}" != -f ]] || { next=$((index + 1)); path="\${!next}"; }
done
printf 'ssh-keygen %s\n' "$path" >>"$FAKE_ROOT/tools.log"
printf private >"$path"
printf 'ssh-ed25519 AAAAC3fixture' >"$path.pub"
`;
const fakeRunner = `#!/usr/bin/env bash
printf 'runner %s\n' "$*" >>"$FAKE_ROOT/tools.log"
[[ "$*" == *'register'* ]] || exit 1
if [[ -n "\${FAKE_RUNNER_JSON:-}" ]]; then
  printf '%s\n' "$FAKE_RUNNER_JSON" >.runner
else
  printf '%s\n' '{"id":1,"uuid":"uuid","name":"runner-fixture","token":"one-job-token","address":"https://gitea.example.test","labels":["dim-qemu"],"ephemeral":true}' >.runner
fi
chmod "\${FAKE_RUNNER_MODE:-0600}" .runner
`;
const fakeScp = `#!/usr/bin/env bash
printf 'scp %s\n' "$*" >>"$FAKE_ROOT/tools.log"
port=""
for ((index=1; index <= $#; index+=1)); do
  [[ "\${!index}" != -P ]] || { next=$((index + 1)); port="\${!next}"; }
done
printf '%s\n' "\${@: -2:1}" >"$FAKE_ROOT/copied-source-$port"
`;
const nodeExecutable = `'${process.execPath.replaceAll("'", "'\\''")}'`;

const fakePython = `#!/usr/bin/env bash
${nodeExecutable} -e 'const fs=require("fs"); const runner=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); const strings=[runner.uuid,runner.name,runner.token,runner.address]; if(!Number.isInteger(runner.id)||runner.id<1||strings.some(value=>typeof value!=="string"||value.length===0)||!Array.isArray(runner.labels)||runner.labels.some(value=>typeof value!=="string"||value.length===0)||runner.ephemeral!==true)process.exit(1)' "\${!#}"
`;
const fakeSsh = `#!/usr/bin/env bash
printf 'ssh %s\n' "$*" >>"$FAKE_ROOT/tools.log"
[[ -z "\${GITEA_RUNNER_REGISTRATION_TOKEN:-}" ]] || exit 41
port=""
for ((index=1; index <= $#; index+=1)); do
  [[ "\${!index}" != -p ]] || { next=$((index + 1)); port="\${!next}"; }
done
[[ "$*" != *'/run/dim-qemu-ci-ready'* ]] || exit 0
if [[ "$*" == *'daemon'* ]]; then
  [[ ! -e "$(cat "$FAKE_ROOT/copied-source-$port")" ]] || exit 31
  if [[ "\${FAKE_DAEMON_HANG:-}" == 1 ]]; then
    while true; do :; done
  fi
  touch "$FAKE_ROOT/guest-finished-$port"
fi
`;
