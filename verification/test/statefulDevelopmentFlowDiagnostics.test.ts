import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const statefulLibrary = resolve(import.meta.dirname, "../scripts/lib/stateful-development-flow.bash");
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("stateful development flow setup diagnostics", () => {
  it("uses the failed container identity for Compose context without replacing the setup failure", async () => {
    // Given
    const root = await mkdtemp(resolve(tmpdir(), "dim-stateful-diagnostics-"));
    temporaryRoots.push(root);
    const toolsRoot = resolve(root, "tools");
    const composeLog = resolve(root, "compose.log");
    await mkdir(toolsRoot);
    const docker = resolve(toolsRoot, "docker");
    const developmentService = resolve(toolsRoot, "dim-development-service");
    await writeFile(developmentService, "#!/usr/bin/env sh\nprintf '%s\\n' 4180\n");
    await chmod(developmentService, 0o700);
    await writeFile(docker, `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1-}" == compose ]]; then
  {
    printf 'container=%s\\n' "\${DIM_TEST_CONTAINER_ID-}"
    printf 'uid=%s\\n' "\${DIM_WORKSPACE_UID-}"
    printf 'gid=%s\\n' "\${DIM_WORKSPACE_GID-}"
    printf 'profiles=%s\\n' "\${COMPOSE_PROFILES-}"
    printf 'args='; printf '<%s>' "$@"; printf '\\n'
  } >>"$DIM_TEST_COMPOSE_LOG"
  printf 'injected compose diagnostic failure\\n' >&2
  exit 73
fi
if [[ "\${1-}" == container && "\${2-}" == inspect ]]; then
  [[ "\${3-}" == --format && "\${4-}" == '{{.Id}}' && "\${5-}" == recorded-name ]]
  printf '%s\\n' 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  exit 0
fi
if [[ "\${1-}" == start ]]; then
  [[ "\${2-}" == aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa ]]
  exit 0
fi
[[ "\${1-}" == exec ]]
shift
declare -a environment=()
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --user|--workdir) shift 2 ;;
    --env) environment+=("$2"); shift 2 ;;
    *) break ;;
  esac
done
container="$1"
shift
[[ "$container" == aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa ]]
case "\${1-}" in
  stat)
    [[ "$*" == "stat -c %u:%g /workspace-data/project" ]]
    printf '%s\\n' '2345:3456'
    ;;
  test) exit 1 ;;
  sh)
    if [[ "\${2-}" == -c ]]; then exit 0; fi
    env "\${environment[@]}" DIM_TEST_CONTAINER_ID="$container" \
      DIM_GIT_USER_NAME=Fixture DIM_GIT_USER_EMAIL=fixture@example.invalid \
      DIM_GIT_USERNAME=fixture DIM_GIT_TOKEN=secret "$@"
    ;;
  docker)
    env "\${environment[@]}" DIM_TEST_CONTAINER_ID="$container" "$@"
    ;;
  *) exit 64 ;;
esac
`);
    await chmod(docker, 0o700);

    // When
    const result = spawnSync("bash", [
      "-c",
      `set -uo pipefail
source "$1"
workspace_name=failed-workspace
dim() {
  printf '%s\\n' '{"containerName":"recorded-name","workspaceDataPath":"/workspace-data","projectManifestPath":"/run/dim/project.json","name":"failed-workspace","profiles":["documentation","secure"]}'
}
setup_failure() { return 42; }
if setup_failure; then
  exit 99
else
  setup_status=$?
  diagnose_workspace_setup
  exit "$setup_status"
fi`,
      "bash",
      statefulLibrary
    ], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${toolsRoot}:${process.env.PATH ?? "/usr/bin:/bin"}`,
        DIM_TEST_COMPOSE_LOG: composeLog
      }
    });

    // Then
    expect(result.status).toBe(42);
    expect(result.stderr).toContain("injected compose diagnostic failure");
    expect(result.stderr).not.toContain("required variable");
    const composeCalls = await readFile(composeLog, "utf8");
    expect(composeCalls).toContain("container=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(composeCalls).toContain("uid=2345");
    expect(composeCalls).toContain("gid=3456");
    expect(composeCalls).toContain("profiles=documentation,secure");
    expect(composeCalls).toContain("args=<compose><--project-name><dim-project>");
    expect(composeCalls).toContain("<--file><.dim/docker-compose.yml><ps>");
    expect(composeCalls).toContain("<--file><.dim/docker-compose.yml><logs>");
  });
});
