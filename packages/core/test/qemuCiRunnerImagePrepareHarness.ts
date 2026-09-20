import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QEMU_CI_NO_HOOK_DIGEST } from "../../../../core/packages/core/src/qemuCiRunnerImage.js";
import { QEMU_CI_PROJECT_NOOP_HOOK_SCRIPT } from "../../../../core/packages/core/src/qemuCiRunnerImageAssets.js";
import { QEMU_CI_IMAGE_PREPARE_SCRIPT } from "../../../../core/packages/core/src/qemuCiRunnerImagePrepareAsset.js";

export interface PrepareHarness {
  readonly root: string;
  readonly commonRoot: string;
  readonly projectRoot: string;
  readonly logPath: string;
  readonly scriptPath: string;
  readonly run: (projectKey: string, extra?: Readonly<Record<string, string>>) => Promise<PrepareResult>;
  readonly cleanup: () => Promise<void>;
}

export interface PrepareResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

const commonKey = "a".repeat(64);

export async function createPrepareHarness(): Promise<PrepareHarness> {
  const root = await mkdtemp(join(tmpdir(), "dim-qemu-image-prepare-"));
  const bin = join(root, "bin");
  const commonRoot = join(root, "common");
  const projectRoot = join(root, "project");
  const logPath = join(root, "tools.log");
  const scriptPath = join(root, "prepare.bash");
  const hookPath = join(root, "cache.bash");
  const children = new Set<ChildProcess>();
  await mkdir(bin);
  await writeExecutable(join(bin, "packer"), fakePacker);
  await writeExecutable(join(bin, "flock"), fakeFlock);
  await writeExecutable(join(bin, "python3"), fakePython);
  await writeExecutable(join(bin, "qemu-img"), fakeQemuImg);
  await writeExecutable(join(bin, "ssh-keygen"), fakeSshKeygen);
  await writeFile(hookPath, QEMU_CI_PROJECT_NOOP_HOOK_SCRIPT, { mode: 0o500 });
  await writeFile(scriptPath, QEMU_CI_IMAGE_PREPARE_SCRIPT
    .replace("/var/lib/dim-qemu-ci-project/cache.bash", hookPath)
    .replace("/usr/local/bin/dim-qemu-ci-verify-ubuntu-image", "true"));
  await chmod(scriptPath, 0o700);
  const run = async (projectKey: string, extra: Readonly<Record<string, string>> = {}): Promise<PrepareResult> => {
    if (extra.FAKE_PACKER_FAIL !== undefined) await writeFile(join(root, "packer-fail"), extra.FAKE_PACKER_FAIL);
    if (extra.FAKE_PACKER_BACKING !== undefined) await writeFile(join(root, "packer-backing"), extra.FAKE_PACKER_BACKING);
    if (extra.FAKE_HOLD_COMMON === projectKey) {
      await writeFile(join(root, `hold-common-${projectKey}`), "");
      createFifo(join(root, `release-common-${projectKey}`));
    }
    if (extra.FAKE_HOLD_PROJECT_KEY === projectKey) {
      await writeFile(join(root, `hold-project-${projectKey}`), "");
      createFifo(join(root, `release-project-${projectKey}`));
    }
    const child = spawn("bash", [scriptPath], {
      env: {
        PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
        DIM_QEMU_CI_COMMON_ROOT: commonRoot,
        DIM_QEMU_CI_PROJECT_CACHE_ROOT: projectRoot,
        DIM_QEMU_CI_COMMON_IMAGE_KEY: commonKey,
        DIM_QEMU_CI_PROJECT_IMAGE_KEY: projectKey,
        DIM_QEMU_CI_PROJECT_HOOK_KIND: "absent",
        DIM_QEMU_CI_PROJECT_HOOK_DIGEST: QEMU_CI_NO_HOOK_DIGEST,
        DIM_QEMU_CI_PROJECT_HOOK_SOURCE_REF: "refs/heads/main",
        DIM_QEMU_CI_PROJECT_HOOK_SOURCE_COMMIT: "f".repeat(40),
        ...extra
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    children.add(child);
    child.once("close", () => children.delete(child));
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    const code = await new Promise<number>((resolve) => child.once("close", (status) => resolve(status ?? 128)));
    return { code, stdout, stderr };
  };
  const cleanup = async (): Promise<void> => {
    const terminations = await Promise.allSettled([...children].map(terminateChild));
    await rm(root, { recursive: true, force: true });
    const failures: unknown[] = [];
    for (const termination of terminations) {
      if (termination.status === "rejected") failures.push(termination.reason);
    }
    if (failures.length > 0) throw new AggregateError(failures, "image preparation child cleanup failed");
  };
  return { root, commonRoot, projectRoot, logPath, scriptPath, run, cleanup };
}

export async function readToolLog(harness: PrepareHarness): Promise<readonly string[]> {
  try {
    return (await readFile(harness.logPath, "utf8")).trim().split("\n").filter(Boolean);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

export function commonImagePath(harness: PrepareHarness): string {
  return join(harness.commonRoot, "images", commonKey, "runner-common.qcow2");
}

export function projectImagePath(harness: PrepareHarness, projectKey: string): string {
  return join(harness.projectRoot, "images", projectKey, "runner-project.qcow2");
}

async function writeExecutable(path: string, content: string): Promise<void> {
  await writeFile(path, content);
  await chmod(path, 0o700);
}

function createFifo(path: string): void {
  const result = spawnSync("mkfifo", [path], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`mkfifo failed: ${result.stderr}`);
}

async function terminateChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`timed out terminating image preparation child ${String(child.pid)}`)), 4_000);
    child.once("close", () => {
      clearTimeout(timeout);
      resolve();
    });
    child.kill("SIGKILL");
  });
}

const fakeFlock = `#!/usr/bin/env bash
set -euo pipefail
root="$(dirname "$(dirname "$0")")"
case "\${1:-}" in
  9)
    printf '%s\n' "$DIM_QEMU_CI_PROJECT_IMAGE_KEY" >"$root/run-key-$PPID"
    touch "$root/common-lock-ready-$DIM_QEMU_CI_PROJECT_IMAGE_KEY"
    ;;
  8) touch "$root/project-lock-ready-$DIM_QEMU_CI_PROJECT_IMAGE_KEY" ;;
esac
exec /usr/bin/flock "$@"
`;

const fakePacker = `#!/usr/bin/env bash
set -euo pipefail
root="$(dirname "$(dirname "$0")")"
log="$root/tools.log"
project_key="$(cat "$root/run-key-$PPID")"
printf 'packer %s\n' "$*" >>"$log"
/usr/bin/env >>"$root/packer-env.log"
[[ "\${1:-}" != init ]] || exit 0
output=""
common=""
template="\${!#}"
for argument in "$@"; do
  case "$argument" in
    output_directory=*) output="\${argument#*=}" ;;
    common_image=*) common="\${argument#*=}" ;;
  esac
done
mkdir -p "$output"
if [[ "$template" == *common* ]]; then
  [[ ! -f "$root/packer-fail" || "$(cat "$root/packer-fail")" != common ]] || exit 29
  if [[ -f "$root/hold-common-$project_key" ]]; then
    touch "$root/common-started-$project_key"
    read -r <"$root/release-common-$project_key"
  fi
  printf common >"$output/runner-common.qcow2"
else
  [[ ! -f "$root/packer-fail" || "$(cat "$root/packer-fail")" != project ]] || exit 29
  touch "$root/project-started-$project_key"
  if [[ -f "$root/hold-project-$project_key" ]]; then
    read -r <"$root/release-project-$project_key"
  fi
  printf project >"$output/runner-project.qcow2"
  backing="$common"
  [[ ! -f "$root/packer-backing" ]] || backing="$(cat "$root/packer-backing")"
  printf '%s\n' "$backing" >"$output/runner-project.qcow2.backing"
fi
`;

const nodeExecutable = `'${process.execPath.replaceAll("'", "'\\''")}'`;

const fakePython = `#!/usr/bin/env bash
set -euo pipefail
source="$(cat)"
if [[ "$source" == *os.rename* ]]; then
  mv -- "$2" "$3"
elif [[ "$source" == *json.dump* ]]; then
  ${nodeExecutable} -e 'const fs=require("fs"); const [,manifest,schema,key,digest,common,kind,hook,sourceRef,sourceCommit]=process.argv; const value={schema,key,artifactSha256:digest}; if(common)value.commonKey=common; if(kind){value.hookKind=kind;value.hookDigest=hook;value.hookSourceRef=sourceRef;value.hookSourceCommit=sourceCommit} fs.writeFileSync(manifest,JSON.stringify(value)+"\\n",{flag:"wx"})' -- "$2" "$3" "$4" "$5" "$6" "\${7:-}" "\${8:-}" "\${9:-}" "\${10:-}"
elif [[ "$source" == *'with open(manifest'* ]]; then
  ${nodeExecutable} -e 'const fs=require("fs"); const [,manifest,schema,key,digest,common,kind,hook,sourceRef,sourceCommit]=process.argv; const value={schema,key,artifactSha256:digest}; if(common)value.commonKey=common; if(kind){value.hookKind=kind;value.hookDigest=hook;value.hookSourceRef=sourceRef;value.hookSourceCommit=sourceCommit} if(JSON.stringify(JSON.parse(fs.readFileSync(manifest,"utf8")))!==JSON.stringify(value))process.exit(1)' -- "$2" "$3" "$4" "$5" "$6" "\${7:-}" "\${8:-}" "\${9:-}" "\${10:-}"
elif [[ "$source" == *'Project image must'* ]]; then
  ${nodeExecutable} -e 'const [,image,payload]=process.argv; const chain=JSON.parse(payload); if(!Array.isArray(chain)||chain.length!==2||chain[0].filename!==image||chain[0].format!=="qcow2"||chain[1].format!=="qcow2"||chain[1]["backing-filename"]!==undefined)process.exit(1); const backing=chain[0]["full-backing-filename"]??chain[0]["backing-filename"]; if(typeof backing!=="string"||chain[1].filename!==backing)process.exit(1); console.log(backing)' -- "$2" "$3"
else
  ${nodeExecutable} -e 'const [,image,payload]=process.argv; const chain=JSON.parse(payload); if(!Array.isArray(chain)||chain.length!==1||chain[0].filename!==image||chain[0].format!=="qcow2"||chain[0]["backing-filename"]!==undefined||chain[0]["full-backing-filename"]!==undefined)process.exit(1)' -- "$2" "$3"
fi
`;

const fakeQemuImg = `#!/usr/bin/env bash
set -euo pipefail
root="$(dirname "$(dirname "$0")")"
printf 'qemu-img %s\n' "$*" >>"$root/tools.log"
command="$1"
image="\${!#}"
if [[ "$command" == check ]]; then
  [[ -s "$image" ]]
  [[ "\${FAKE_QEMU_IMG_FAIL_CHECK:-}" != "$(basename "$image")" ]]
elif [[ "$command" == info ]]; then
  if [[ "$image" == *runner-common.qcow2 ]]; then
    [[ "\${FAKE_COMMON_CHAIN:-valid}" == valid ]] || printf '[{"filename":"%s","format":"qcow2","backing-filename":"bad"}]\n' "$image"
    [[ "\${FAKE_COMMON_CHAIN:-valid}" != valid ]] || printf '[{"filename":"%s","format":"qcow2"}]\n' "$image"
  else
    backing="$(cat "$image.backing")"
    [[ "\${FAKE_PROJECT_CHAIN:-valid}" == valid ]] || backing="\${backing}.wrong"
    printf '[{"filename":"%s","format":"qcow2","backing-filename":"%s"},{"filename":"%s","format":"qcow2"}]\n' "$image" "$backing" "$backing"
  fi
elif [[ "$command" == rebase ]]; then
  backing=""
  for ((index=1; index <= $#; index+=1)); do
    [[ "\${!index}" != -b ]] || { next=$((index + 1)); backing="\${!next}"; }
  done
  printf '%s\n' "$backing" >"$image.backing"
fi
`;

const fakeSshKeygen = `#!/usr/bin/env bash
set -euo pipefail
root="$(dirname "$(dirname "$0")")"
printf 'ssh-keygen %s\n' "$*" >>"$root/tools.log"
path=""
for ((index=1; index <= $#; index+=1)); do
  [[ "\${!index}" != -f ]] || { next=$((index + 1)); path="\${!next}"; }
done
printf private >"$path"
printf public >"$path.pub"
`;
