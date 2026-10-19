import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const workspaceRoot = resolve(import.meta.dirname, "../../..");
const bootstrapSource = resolve(workspaceRoot, "scripts/bootstrap-ubuntu-vm.bash");
const realLauncher = resolve(workspaceRoot, "packages/installer/src/dim");
const roots: string[] = [];
const reviewedSha = "a".repeat(40);
export const bundleVersion = `0.10.0-local-${"b".repeat(64)}`;

export type Fixture = {
  readonly bootstrap: string;
  readonly home: string;
  readonly log: string;
  readonly root: string;
  readonly source: string;
  readonly tools: string;
  readonly trustedNodeLog: string;
};

async function executable(path: string, body: string): Promise<void> {
  await writeFile(path, `#!/usr/bin/env bash\nset -euo pipefail\n${body}`);
  await chmod(path, 0o755);
}

export async function fixture(groups = "operator docker kvm"): Promise<Fixture> {
  const root = await mkdtemp(resolve(tmpdir(), "dim-bootstrap-ubuntu-vm-"));
  roots.push(root);
  const source = resolve(root, "source");
  const tools = resolve(root, "tools");
  const helpers = resolve(root, "helpers");
  const home = resolve(root, "home");
  const log = resolve(root, "commands.log");
  const bootstrap = resolve(source, "scripts/bootstrap-ubuntu-vm.bash");
  const facadeInstaller = resolve(source, "scripts/lib/install-candidate-facade.bash");
  const facadeFormat = resolve(source, "scripts/lib/candidate-facade-format.bash");
  const pins = resolve(source, "scripts/lib/bootstrap-ubuntu-pins.bash");
  const preflight = resolve(source, "scripts/lib/bootstrap-host-preflight.bash");
  const state = resolve(source, "scripts/lib/bootstrap-host-state.bash");
  const trustedNode = resolve(root, "trusted-node/bin/node");
  const sourceTools = resolve(root, "source-tools");
  const trustedNodeLog = resolve(root, "trusted-node.log");
  await Promise.all([mkdir(resolve(source, "scripts/lib"), { recursive: true }), mkdir(resolve(trustedNode, ".."), { recursive: true }), mkdir(resolve(sourceTools, "bin"), { recursive: true }), mkdir(tools), mkdir(helpers), mkdir(home)]);
  await writeFile(log, "");
  await writeFile(resolve(source, "package.json"), '{"version":"0.10.0"}\n');
  await writeFile(resolve(root, "os-release"), 'ID=ubuntu\nVERSION_ID="24.04"\n');
  await writeFile(resolve(root, "kvm"), "fixture\n");
  await writeFile(trustedNodeLog, "");
  const helperBody = 'printf "%s\\n" "$(basename "$0") $*" >>"$DIM_TEST_LOG"\n';
  for (const name of ["host", "tools", "kvm"] as const) {
    const configBody = name === "host"
      ? 'printf \'{"runtimes":{"sysbox-runc":{}}}\n\' >"$DIM_TEST_DAEMON_CONFIG"\nchmod 0644 "$DIM_TEST_DAEMON_CONFIG"\n'
      : "";
    await executable(resolve(helpers, `${name}.bash`), `${helperBody}${configBody}`);
  }
  await executable(resolve(tools, "id"), `
 case "\${1:-}" in
   -u) printf '1000\\n' ;;
   -un) printf 'operator\\n' ;;
   -nG) printf '%s\\n' "\${DIM_TEST_GROUPS:-${groups}}" ;;
   *) /usr/bin/id "$@" ;;
 esac
 `);
  await executable(resolve(tools, "dpkg"), "printf 'amd64\\n'\n");
  await executable(resolve(tools, "dpkg-query"), `
 case "\${*: -1}" in
   docker-ce|docker-ce-cli) printf '%s' "\${DIM_TEST_DOCKER_PACKAGE_VERSION:-5:29.1.4-1~ubuntu.24.04~noble}" ;;
   containerd.io) printf '2.2.1-1~ubuntu.24.04~noble' ;;
   docker-buildx-plugin) printf '0.31.1-1~ubuntu.24.04~noble' ;;
   docker-compose-plugin) printf '2.40.3-1~ubuntu.24.04~noble' ;;
    sysbox-ce) printf '%s' "\${DIM_TEST_SYSBOX_PACKAGE_VERSION:-0.7.0.linux}" ;;
   *) exit 1 ;;
 esac
 `);
  // The fixture's sudo does not elevate. Model only the root ownership of
  // daemon.json that the real privileged installer creates.
  await executable(resolve(tools, "stat"), `
if [[ "$*" == "-c %u:%a $DIM_TEST_DAEMON_CONFIG" ]]; then
  mode="$(/usr/bin/stat -c %a "$DIM_TEST_DAEMON_CONFIG")"
  printf '0:%s\\n' "$mode"
else
  exec /usr/bin/stat "$@"
fi
`);
  await executable(resolve(tools, "sudo"), 'exec "$@"\n');
  await executable(resolve(tools, "git"), `
 case "$*" in
   *"rev-parse --show-toplevel"*) printf '${source}\\n' ;;
   *"rev-parse --verify HEAD"*) printf '%s\\n' "\${DIM_TEST_HEAD:-${reviewedSha}}" ;;
   *"status --porcelain=v1 --untracked-files=all"*) printf '%s' "\${DIM_TEST_STATUS:-}" ;;
   *) exit 64 ;;
 esac
 `);
  await executable(resolve(tools, "docker"), `
 case "$*" in
   "ps -aq") printf '%s' "\${DIM_TEST_CONTAINERS:-}" ;;
   "volume ls -q") printf '%s' "\${DIM_TEST_VOLUMES:-}" ;;
   "image ls -q") printf '%s' "\${DIM_TEST_IMAGES:-}" ;;
   "network ls --format {{.Name}}") printf '%b\\n' "\${DIM_TEST_NETWORKS:-bridge\\nhost\\nnone}" ;;
   "compose version --short") printf '%s\\n' "\${DIM_TEST_COMPOSE_VERSION:-2.40.3}" ;;
   "context show") printf '%s\\n' "\${DIM_TEST_DOCKER_CONTEXT:-default}" ;;
   "context inspect default --format {{.Endpoints.docker.Host}}") printf '%s\\n' "\${DIM_TEST_DOCKER_ENDPOINT:-unix:///var/run/docker.sock}" ;;
   "version --format {{.Server.Version}}") printf '29.1.4\\n' ;;
   "info --format {{json .DriverStatus}}") printf '[['"'"'driver-type'"'"','"'"'io.containerd.snapshotter.v1'"'"']]\\n' ;;
   "info --format {{json .Runtimes}}") printf '{"sysbox-runc":{}}\\n' ;;
   image*) printf 'sha256:%064d\\n' 0 ;;
   *) exit 0 ;;
 esac
 `);
  await executable(resolve(tools, "just"), `
 printf 'just %s\\n' "$*" >>"$DIM_TEST_LOG"
 if [[ "$1" == prepare-local ]]; then
   mkdir -p .local/dim-packages
   cat >.local/dim-packages/packages.json <<'JSON'
{"schemaVersion":1,"packages":[{"name":"@slop-lab/dim-cli","version":"${bundleVersion}","file":"slop-lab-dim-cli-${bundleVersion}.tgz"},{"name":"@slop-lab/dim-installer","version":"${bundleVersion}","file":"slop-lab-dim-installer-${bundleVersion}.tgz"}]}
JSON
   : >.local/dim-packages/slop-lab-dim-cli-${bundleVersion}.tgz
   : >.local/dim-packages/slop-lab-dim-installer-${bundleVersion}.tgz
   printf 'root=${reviewedSha}\\naggregate-lock-sha256=%064d\\n' 0 >.local/dim-packages/.dim-source-state
   DIM_LOCAL_PACKAGE_ROOT="$PWD/.local/dim-packages" DIM_LOCAL_IMAGE_INSPECT_REF="dev-infra-project-workspace:${bundleVersion}" DIM_LOCAL_IMAGE_RECORD_REF="dev-infra-project-workspace:${bundleVersion}" bash scripts/local-preparation-state.bash >.local/prepared-local.state
 fi
 `);
  await executable(resolve(tools, "npm"), `
 printf 'npm %s\\n' "$*" >>"$DIM_TEST_LOG"
 prefix=""
 while (($#)); do [[ "$1" == --prefix ]] && { prefix="$2"; shift; }; shift; done
 mkdir -p "$prefix/node_modules/.bin" "$prefix/node_modules/dim-fixture"
 cp "$DIM_TEST_REAL_LAUNCHER" "$prefix/node_modules/dim-fixture/dim"
 chmod 0755 "$prefix/node_modules/dim-fixture/dim"
 printf 'if (require("node:child_process").spawnSync("node", ["--version"]).status !== 0) process.exit(70);\\nprocess.stdout.write("DIM CLI 0.10.0-local-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb (via DIM installer 0.10.0-local-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb)\\\\n")\\n' >"$prefix/node_modules/dim-fixture/cli.js"
 ln -s ../dim-fixture/dim "$prefix/node_modules/.bin/dim"
 [[ -z "\${DIM_TEST_MUTATE_PREPARED:-}" ]] || printf 'drift\\n' >>"$PWD/.local/prepared-local.state"
 `);
  // Model the installed Ubuntu target's pinned version independently of the
  // test runner (Node 24 or 26); execute fixture JavaScript with the real runner.
  await executable(trustedNode, `
printf 'trusted-node\\n' >>${JSON.stringify(trustedNodeLog)}
if [[ "\${1:-}" == --version ]]; then
  printf '%s\\n' "\${DIM_TEST_TRUSTED_NODE_VERSION:-v24.19.0}"
  exit 0
fi
exec ${JSON.stringify(process.execPath)} "$@"
`);
  await executable(resolve(sourceTools, "bin/pnpm"), "printf '10.13.1\\n'\n");
  await executable(resolve(sourceTools, "bin/just"), "printf 'just 1.43.1\\n'\n");
  await executable(resolve(tools, "node"), `exec ${JSON.stringify(process.execPath)} "$@"\n`);
  await writeFile(pins, (await readFile(resolve(workspaceRoot, "scripts/lib/bootstrap-ubuntu-pins.bash"), "utf8"))
    .replace(/^dim_node_root=.*$/m, `dim_node_root=${JSON.stringify(resolve(trustedNode, "../.."))}`)
    .replace(/^dim_source_tools_root=.*$/m, `dim_source_tools_root=${JSON.stringify(sourceTools)}`));
  await writeFile(facadeFormat, await readFile(resolve(workspaceRoot, "scripts/lib/candidate-facade-format.bash"), "utf8"));
  await writeFile(preflight, await readFile(resolve(workspaceRoot, "scripts/lib/bootstrap-host-preflight.bash"), "utf8"));
  await writeFile(state, await readFile(resolve(workspaceRoot, "scripts/lib/bootstrap-host-state.bash"), "utf8"));
  await writeFile(resolve(source, "scripts/local-package-version.bash"), await readFile(resolve(workspaceRoot, "scripts/local-package-version.bash"), "utf8"));
  await writeFile(resolve(source, "scripts/local-preparation-state.bash"), await readFile(resolve(workspaceRoot, "scripts/local-preparation-state.bash"), "utf8"));
  await writeFile(facadeInstaller, await readFile(resolve(workspaceRoot, "scripts/lib/install-candidate-facade.bash"), "utf8"));
  await chmod(facadeInstaller, 0o755);
  const sourceText = await readFile(bootstrapSource, "utf8");
  await writeFile(bootstrap, sourceText
    .replace(/^repo_root=.*$/m, `repo_root=${JSON.stringify(source)}`)
    .replace(/^host_installer=.*$/m, `host_installer=${JSON.stringify(resolve(helpers, "host.bash"))}`)
    .replace(/^tool_installer=.*$/m, `tool_installer=${JSON.stringify(resolve(helpers, "tools.bash"))}`)
    .replace(/^kvm_installer=.*$/m, `kvm_installer=${JSON.stringify(resolve(helpers, "kvm.bash"))}`)
    .replace(/^facade_installer=.*$/m, `facade_installer=${JSON.stringify(facadeInstaller)}`)
    .replace(/^facade_format_helper=.*$/m, `facade_format_helper=${JSON.stringify(facadeFormat)}`)
    .replace(/^os_release=.*$/m, `os_release=${JSON.stringify(resolve(root, "os-release"))}`)
    .replace(/^kvm_device=.*$/m, "kvm_device=/dev/null")
    .replace(/^resume_marker_root=.*$/m, `resume_marker_root=${JSON.stringify(resolve(home, ".local/state/dim-bootstrap"))}`)
    .replace(/^docker_daemon_config=.*$/m, `docker_daemon_config=${JSON.stringify(resolve(root, "daemon.json"))}`)
    .replace(/^docker_systemd_overrides=.*$/m, `docker_systemd_overrides=${JSON.stringify(resolve(root, "docker.service.d"))}`)
    .replace(/^docker_data_root=.*$/m, `docker_data_root=${JSON.stringify(resolve(root, "var/lib/docker"))}`)
    .replace(/^containerd_data_root=.*$/m, `containerd_data_root=${JSON.stringify(resolve(root, "var/lib/containerd"))}`)
    .replace(/^runtime_path=.*$/m, `runtime_path=${JSON.stringify(`${tools}:/usr/bin:/bin`)}`)
    .replace(/^export PATH="\$dim_source_tools_root.*$/m, `export PATH=${JSON.stringify(`${tools}:/usr/bin:/bin`)}`)
    .replace(/^operator_uid=.*$/m, "operator_uid=$(/usr/bin/id -u)"));
  await chmod(bootstrap, 0o755);
  return { bootstrap, home, log, root, source, tools, trustedNodeLog };
}

export function run(value: Fixture, args: readonly string[], environment: Readonly<Record<string, string>> = {}) {
  return spawnSync("/usr/bin/bash", [value.bootstrap, ...args], {
    cwd: workspaceRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${value.tools}:/usr/bin:/bin`,
      HOME: value.home,
      DOCKER_API_VERSION: undefined,
      DOCKER_CERT_PATH: undefined,
      DOCKER_CONFIG: undefined,
      DOCKER_CONTEXT: undefined,
      DOCKER_HOST: undefined,
      DOCKER_TLS_VERIFY: undefined,
      DIM_TEST_LOG: value.log,
      DIM_TEST_DAEMON_CONFIG: resolve(value.root, "daemon.json"),
      DIM_TEST_REAL_LAUNCHER: realLauncher,
      ...environment,
    },
  });
}

export const executeArgs = ["--role", "ordinary", "--source-sha", reviewedSha, "--expected-version", "0.10.0", "--acknowledge-fresh-vm"] as const;

export async function cleanup(): Promise<void> {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
}
