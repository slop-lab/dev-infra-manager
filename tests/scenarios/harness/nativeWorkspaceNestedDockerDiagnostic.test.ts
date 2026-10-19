import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const diagnostic = resolve(import.meta.dirname, "../../../scripts/checks/native-workspace-nested-docker-diagnostic.bash");
const workspaceImage = "dev-infra-project-workspace:0.9.0";
const probeImage = `alpine@sha256:${"3".repeat(64)}`;
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("native workspace nested Docker diagnostic", { timeout: 20_000 }, () => {
  it("runs the Sysbox lane after the runc image execution fails", async () => {
    // Given
    const fixture = await createFixture({ failureLane: "runc" });

    // When
    const result = runDiagnostic(fixture);

    // Then
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("lane=runc status=FAIL reason=nested-image-run");
    expect(result.stdout).toContain("runc overlay mount: invalid argument");
    expect(result.stdout).toContain("lane=sysbox status=PASS");
    expect(result.stdout).toContain("aggregate=FAIL failed_lanes=runc");
    const calls = await readFile(fixture.callLog, "utf8");
    expect(calls).toContain("DIM_DOCKERD_FLAGS=--feature containerd-snapshotter=false");
    expect(calls).toMatch(/exec --user dim a{64} docker run/);
    expect(calls).toMatch(/exec --user dim b{64} docker run/);
  });

  it("retains the runc result after the Sysbox image execution fails", async () => {
    // Given
    const fixture = await createFixture({ failureLane: "sysbox" });

    // When
    const result = runDiagnostic(fixture);

    // Then
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("lane=runc status=PASS");
    expect(result.stdout).toContain("lane=sysbox status=FAIL reason=nested-image-run");
    expect(result.stdout).toContain("sysbox overlay mount: invalid argument");
    expect(result.stdout).toContain("aggregate=FAIL failed_lanes=sysbox");
  });

  it("refuses cleanup after a resource loses its diagnostic ownership", async () => {
    // Given
    const fixture = await createFixture({ foreignLane: "runc" });

    // When
    const result = runDiagnostic(fixture);

    // Then
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("cleanup=REFUSED resource=container");
    expect(result.stdout).toContain("lane=runc status=FAIL reason=cleanup-incomplete");
    const calls = await readFile(fixture.callLog, "utf8");
    expect(calls).not.toContain(`container rm --force ${"a".repeat(64)}`);
    expect(calls).toContain(`container rm --force ${"b".repeat(64)}`);
  });

  it("reports incomplete cleanup when inspect loses the daemon after container creation", async () => {
    // Given
    const fixture = await createFixture({ inspectFailureLane: "runc", inspectFailureAfter: 1 });

    // When
    const result = runDiagnostic(fixture);

    // Then
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("cleanup=FAILED resource=container");
    expect(result.stderr).toContain("Cannot connect to the Docker daemon");
    expect(result.stdout).toContain("lane=runc status=FAIL reason=cleanup-incomplete");
    expect(result.stdout).not.toContain("lane=runc status=PASS");
    expect(result.stdout).toContain("lane=sysbox status=PASS");
    expect(result.stdout).toContain("aggregate=FAIL failed_lanes=runc");
  });

  it("runs exit cleanup when ownership inspection fails before nested image load", async () => {
    // Given
    const fixture = await createFixture({ inspectFailureLane: "runc", inspectFailureAfter: 7 });

    // When
    const result = runDiagnostic(fixture);

    // Then
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("lane=runc status=FAIL reason=cleanup-incomplete");
    expect(result.stdout).not.toContain("lane=runc status=PASS");
    expect(result.stdout).toContain("lane=sysbox status=PASS");
    expect(result.stdout).toContain("aggregate=FAIL failed_lanes=runc");
    const calls = await readFile(fixture.callLog, "utf8");
    expect(calls).not.toMatch(/exec --user dim a{64} docker image load/);
    expect(calls).toContain(`volume inspect dim-nested-runc-`);
    expect(calls).not.toContain(`volume rm dim-nested-runc-`);
  });

  it("treats an exact missing-container response as completed cleanup", async () => {
    // Given
    const fixture = await createFixture({ missingLane: "runc" });

    // When
    const result = runDiagnostic(fixture);

    // Then
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("lane=runc status=PASS");
    expect(result.stdout).toContain("lane=sysbox status=PASS");
    expect(result.stdout).toContain("aggregate=PASS failed_lanes=none");
  });

  it("classifies inspect syntax errors as cleanup failures", async () => {
    // Given
    const fixture = await createFixture({
      inspectFailureLane: "runc",
      inspectFailureAfter: 8,
      inspectFailureKind: "syntax"
    });

    // When
    const result = runDiagnostic(fixture);

    // Then
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("cleanup=FAILED resource=container");
    expect(result.stderr).toContain("template parsing error");
    expect(result.stdout).toContain("lane=runc status=FAIL reason=cleanup-incomplete");
    expect(result.stdout).not.toContain("lane=runc status=PASS");
  });

  it("runs ownership-checked cleanup when a lane is terminated", async () => {
    // Given
    const fixture = await createFixture({ terminateLane: "runc" });

    // When
    const result = runDiagnostic(fixture);

    // Then
    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain("lane=runc status=PASS");
    expect(result.stdout).toContain("lane=sysbox status=PASS");
    expect(result.stdout).toContain("aggregate=FAIL failed_lanes=runc");
    const calls = await readFile(fixture.callLog, "utf8");
    expect(calls).toContain(`container rm --force ${"a".repeat(64)}`);
    expect(calls).toContain(`volume rm dim-nested-runc-`);
  });

  it("completes the runc lane when Sysbox is unavailable", async () => {
    // Given
    const fixture = await createFixture({ sysboxAvailable: false });

    // When
    const result = runDiagnostic(fixture);

    // Then
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("lane=runc status=PASS");
    expect(result.stdout).toContain("lane=sysbox status=UNAVAILABLE reason=sysbox-runc-not-registered");
    expect(result.stdout).toContain("aggregate=FAIL failed_lanes=sysbox");
  });

  it("is executable and has valid Bash syntax", async () => {
    // Given / When
    const syntax = spawnSync("bash", ["-n", diagnostic], { encoding: "utf8" });
    const mode = (await stat(diagnostic)).mode & 0o777;

    // Then
    expect(syntax.status, syntax.stderr).toBe(0);
    expect(mode & 0o111).toBe(0o111);
  });

  it("uses the supported Docker PID limit flag in the companion Sysbox isolation gate", async () => {
    const gate = resolve(import.meta.dirname, "../../../scripts/checks/container-sysbox-isolation-smoke.bash");
    const source = await readFile(gate, "utf8");
    expect(source).toContain("--pids-limit 128");
    expect(source).not.toMatch(/\s--pids 128\b/);
  });
});

type Fixture = {
  readonly root: string;
  readonly callLog: string;
  readonly failureLane: string;
  readonly foreignLane: string;
  readonly sysboxAvailable: boolean;
  readonly inspectFailureLane: string;
  readonly inspectFailureAfter: number;
  readonly missingLane: string;
  readonly inspectFailureKind: string;
  readonly terminateLane: string;
};

type FixtureOptions = {
  readonly failureLane?: string;
  readonly foreignLane?: string;
  readonly sysboxAvailable?: boolean;
  readonly inspectFailureLane?: string;
  readonly inspectFailureAfter?: number;
  readonly missingLane?: string;
  readonly inspectFailureKind?: string;
  readonly terminateLane?: string;
};

async function createFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "dim-nested-diagnostic-test-"));
  temporaryRoots.push(root);
  const bin = join(root, "bin");
  const state = join(root, "state");
  const callLog = join(root, "docker-calls");
  await mkdir(bin);
  await mkdir(state);
  const docker = join(bin, "docker");
  await writeFile(docker, dockerFake, { mode: 0o755 });
  return {
    root,
    callLog,
    failureLane: options.failureLane ?? "none",
    foreignLane: options.foreignLane ?? "none",
    sysboxAvailable: options.sysboxAvailable ?? true,
    inspectFailureLane: options.inspectFailureLane ?? "none",
    inspectFailureAfter: options.inspectFailureAfter ?? 0,
    missingLane: options.missingLane ?? "none",
    inspectFailureKind: options.inspectFailureKind ?? "transport",
    terminateLane: options.terminateLane ?? "none"
  };
}

function runDiagnostic(fixture: Fixture) {
  return spawnSync("bash", [diagnostic, workspaceImage, probeImage], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${join(fixture.root, "bin")}:/usr/bin:/bin`,
      MOCK_DOCKER_CALLS: fixture.callLog,
      MOCK_DOCKER_STATE: join(fixture.root, "state"),
      MOCK_FAILURE_LANE: fixture.failureLane,
      MOCK_FOREIGN_LANE: fixture.foreignLane,
      MOCK_SYSBOX_AVAILABLE: String(fixture.sysboxAvailable),
      MOCK_INSPECT_FAILURE_LANE: fixture.inspectFailureLane,
      MOCK_INSPECT_FAILURE_AFTER: String(fixture.inspectFailureAfter),
      MOCK_INSPECT_FAILURE_KIND: fixture.inspectFailureKind,
      MOCK_MISSING_LANE: fixture.missingLane,
      MOCK_TERMINATE_LANE: fixture.terminateLane,
      MOCK_PROBE_IMAGE: probeImage
    }
  });
}

const dockerFake = `#!/usr/bin/env bash
set -u
printf '%s\n' "$*" >>"$MOCK_DOCKER_CALLS"
workspace_id="sha256:${"1".repeat(64)}"
probe_id="sha256:${"2".repeat(64)}"
runc_id="${"a".repeat(64)}"
sysbox_id="${"b".repeat(64)}"

if [[ "$1 $2" == "info --format" ]]; then
  case "$3" in
    *ServerVersion*) printf '29.1.3\n' ;;
    *Runtimes*)
      if [[ "$MOCK_SYSBOX_AVAILABLE" == true ]]; then printf '{"runc":{},"sysbox-runc":{}}\n'; else printf '{"runc":{}}\n'; fi ;;
    *Backing?Filesystem*) printf 'extfs\n' ;;
    *driver-type*) printf 'io.containerd.snapshotter.v1\n' ;;
    *CgroupDriver*) printf 'systemd\n' ;;
    *CgroupVersion*) printf '2\n' ;;
    *DockerRootDir*) printf '/var/lib/docker\n' ;;
    *Driver*) printf 'overlayfs\n' ;;
  esac
  exit 0
fi
if [[ "$1 $2" == "image inspect" ]]; then
  if [[ "$3" == "$MOCK_PROBE_IMAGE" ]]; then
    printf '%s|%s\n' "$probe_id" "$MOCK_PROBE_IMAGE"
  else
    printf '%s\n' "$workspace_id"
  fi
  exit 0
fi
if [[ "$1 $2" == "image save" ]]; then
  : >"$4"
  exit 0
fi
if [[ "$1 $2" == "volume create" ]]; then
  name="\${!#}"; scope=
  for argument in "$@"; do
    [[ "$argument" == org.dim.verification.scope=* ]] && scope="\${argument#*=}"
  done
  printf '%s\n' "$scope" >"$MOCK_DOCKER_STATE/volume-$name"
  printf '%s\n' "$name"
  exit 0
fi
if [[ "$1 $2" == "volume inspect" ]]; then
  name="$3"
  lane=none
  [[ "$name" == dim-nested-runc-* ]] && lane=runc
  [[ "$name" == dim-nested-sysbox-* ]] && lane=sysbox
  if [[ -e "$MOCK_DOCKER_STATE/inspect-failed-$lane" ]]; then
    printf 'Cannot connect to the Docker daemon\n' >&2
    exit 1
  fi
  if [[ ! -e "$MOCK_DOCKER_STATE/volume-$name" ]]; then
    printf 'Error response from daemon: get %s: no such volume\n' "$name" >&2
    exit 1
  fi
  printf '%s|local|native-workspace-nested-docker-diagnostic|%s\n' "$name" "$(<"$MOCK_DOCKER_STATE/volume-$name")"
  exit 0
fi
if [[ "$1 $2" == "volume rm" ]]; then
  rm -f "$MOCK_DOCKER_STATE/volume-$3"
  exit 0
fi
if [[ "$1 $2" == "container create" ]]; then
  shift 2
  name= runtime= scope= privileged=false data_mount=
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      --name) name="$2"; shift 2 ;;
      --runtime) runtime="$2"; shift 2 ;;
      --label)
        [[ "$2" == org.dim.verification.scope=* ]] && scope="\${2#*=}"
        shift 2 ;;
      --mount)
        [[ "$2" == *target=/var/lib/dim/workspace-data || "$2" == *target=/var/lib/docker ]] && data_mount="$2"
        shift 2 ;;
      --privileged) privileged=true; shift ;;
      *) shift ;;
    esac
  done
  [[ "$runtime" == runc ]] && id="$runc_id" || id="$sysbox_id"
  printf '%s\n' "$scope" >"$MOCK_DOCKER_STATE/scope"
  printf '%s|%s|%s|%s|%s\n' "$name" "$scope" "$runtime" "$privileged" "$data_mount" >"$MOCK_DOCKER_STATE/container-$id"
  printf '%s\n' "$id"
  exit 0
fi
if [[ "$1 $2" == "container inspect" ]]; then
  target="$3"
  metadata=
  for candidate in "$MOCK_DOCKER_STATE"/container-*; do
    [[ -e "$candidate" ]] || continue
    IFS='|' read -r name scope runtime privileged data_mount <"$candidate"
    [[ "$target" == "$name" || "$target" == "\${candidate##*-}" ]] && { metadata="$candidate"; break; }
  done
  if [[ -z "$metadata" ]]; then
    printf 'Error response from daemon: No such container: %s\n' "$target" >&2
    exit 1
  fi
  IFS='|' read -r name scope runtime privileged data_mount <"$metadata"
  id="\${metadata##*-}"
  [[ "$id" == "$runc_id" ]] && lane=runc || lane=sysbox
  count_file="$MOCK_DOCKER_STATE/inspect-count-$lane"
  count=0
  [[ -e "$count_file" ]] && count="$(<"$count_file")"
  count=$((count + 1))
  printf '%s\n' "$count" >"$count_file"
  if [[ "$MOCK_INSPECT_FAILURE_LANE" == "$lane" && "$count" -ge "$MOCK_INSPECT_FAILURE_AFTER" ]]; then
    touch "$MOCK_DOCKER_STATE/inspect-failed-$lane"
    if [[ "$MOCK_INSPECT_FAILURE_KIND" == syntax ]]; then
      printf 'template parsing error: unexpected EOF\n' >&2
      exit 64
    fi
    printf 'Cannot connect to the Docker daemon\n' >&2
    exit 1
  fi
  [[ -e "$MOCK_DOCKER_STATE/foreign-$id" ]] && scope=foreign
  if [[ "$*" == *'.Mounts'* ]]; then
    destination="\${data_mount##*target=}"
    source="\${data_mount#*source=}"; source="\${source%%,*}"
    printf 'volume|%s|%s|true\n' "$source" "$destination"
  elif [[ "$*" == *'.HostConfig.Runtime'* ]]; then
    printf '%s|%s\n' "$runtime" "$privileged"
  else
    printf '%s|/%s|native-workspace-nested-docker-diagnostic|%s\n' "$id" "$name" "$scope"
  fi
  exit 0
fi
if [[ "$1 $2" == "container start" ]]; then exit 0; fi
if [[ "$1 $2" == "container rm" ]]; then
  target="\${!#}"
  rm -f "$MOCK_DOCKER_STATE/container-$target"
  exit 0
fi
if [[ "$1" == exec ]]; then
  shift
  while [[ "$#" -gt 0 && ! "$1" =~ ^[ab]{64}$ ]]; do shift; done
  id="$1"; shift
  [[ "$id" == "$runc_id" ]] && lane=runc || lane=sysbox
  command_line=" $* "
  if [[ "$command_line" == *' docker info '* ]]; then
    case "$command_line" in
      *Backing?Filesystem*) printf 'extfs\n' ;;
      *driver-type*) printf 'io.containerd.snapshotter.v1\n' ;;
      *CgroupDriver*) printf 'systemd\n' ;;
      *CgroupVersion*) printf '2\n' ;;
      *DockerRootDir*) printf '/var/lib/docker\n' ;;
      *--format*Driver*) printf 'overlayfs\n' ;;
    esac
    exit 0
  fi
  if [[ "$command_line" == *' id -u '* ]]; then printf '1001\n'; exit 0; fi
  if [[ "$command_line" == *' stat -f -c %T '* ]]; then printf 'overlayfs\n'; exit 0; fi
  if [[ "$command_line" == *' docker image load '* ]]; then
    if [[ "$MOCK_TERMINATE_LANE" == "$lane" ]]; then
      lane_pid="$(ps -o ppid= -p "$PPID" | tr -d ' ')"
      kill -TERM "$lane_pid"
    fi
    cat >/dev/null
    printf 'Loaded image\n'
    exit 0
  fi
  if [[ "$command_line" == *' docker image inspect '* ]]; then printf '%s\n' "$probe_id"; exit 0; fi
  if [[ "$command_line" == *' docker run '* ]]; then
    if [[ "$MOCK_FAILURE_LANE" == "$lane" ]]; then
      printf '%s overlay mount: invalid argument\n' "$lane" >&2
      exit 125
    fi
    printf '0\nnested-image-execution-ok\n'
    [[ "$MOCK_FOREIGN_LANE" == "$lane" ]] && touch "$MOCK_DOCKER_STATE/foreign-$id"
    [[ "$MOCK_MISSING_LANE" == "$lane" ]] && rm -f "$MOCK_DOCKER_STATE/container-$id"
    exit 0
  fi
fi
printf 'unexpected docker invocation: %s\n' "$*" >&2
exit 90
`;
