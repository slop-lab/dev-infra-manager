# Native cutover clean-host smoke

This is an operator runbook for a real installed **disposable multi-node Linux
smoke**. It exercises one dual-kind happy path. It does not satisfy the
still-unimplemented `VERIFICATION-NATIVE-CUTOVER-001` acceptance gate in
`specification/specs/12-verification.md`, which additionally requires policy
variants, stale/wrong-kind/failure and replay denials, crash/restart recovery,
guest-authority inspection, and traffic inspection.

The packaged smoke entrypoint is:

```bash
cp verification/native-cutover-clean-host.conf.example /absolute/operator/native-cutover.conf
chmod 0600 /absolute/operator/native-cutover.conf
bash verification/scripts/native-cutover-clean-host.bash --preflight-only \
  /absolute/operator/native-cutover.conf
bash verification/scripts/native-cutover-clean-host.bash \
  /absolute/operator/native-cutover.conf
# Equivalent recipe:
just verify native-cutover-clean-host-smoke /absolute/operator/native-cutover.conf
```

Fill every literal in the example from the host-guide files below. SSH aliases
come from the operator's reviewed SSH configuration; the harness accepts no
caller command or SSH option. The ordinary node must be independent from the
control/QEMU node. The production QEMU host schema supports authenticated
operator-managed HTTPS for native Git. This smoke intentionally requires its
QEMU worker and native Git endpoint to be control-local loopback so the current
two-node topology has one fewer external trust dependency; that is a harness
limit, not a production transport limit. `--preflight-only` checks connectivity,
exact source/package provenance, private files, node separation, Sysbox, KVM,
runner images, and Docker `type=image` support before creating evidence or
installing anything. Exit `2` is unavailable and includes the operator action.
Success atomically publishes a bounded `SMOKE-PASSED` JSON manifest; it is
never full-gate acceptance.

The command deliberately sets `PROTECTED_QEMU_MODE=unused`: native QEMU uses
the installed host worker, not `/run/dim/qemu-verification/service.sock`.
Changing that value refuses before SSH. A socket probe cannot attest the
protected service's source root, and the command never restarts or repoints that
service. Human approval is interactive and requires typing the complete
candidate commit after inspecting the recorded review.

## Run the four-profile quality-policy matrix

The policy-matrix entrypoint extends the bounded smoke with four fresh native
Projects whose reviewed roots select, respectively, no jobs, ordinary Sysbox
only, QEMU only, and both execution kinds:

```bash
cp verification/native-cutover-policy-matrix.conf.example \
  /absolute/operator/native-cutover-matrix.conf
chmod 0600 /absolute/operator/native-cutover-matrix.conf
bash verification/scripts/native-cutover-policy-matrix.bash --preflight-only \
  /absolute/operator/native-cutover-matrix.conf
bash verification/scripts/native-cutover-policy-matrix.bash \
  /absolute/operator/native-cutover-matrix.conf
# Equivalent recipe:
just verify native-cutover-policy-matrix /absolute/operator/native-cutover-matrix.conf
```

Each `*_PROJECT_SOURCE`, `*_PROJECT_REF`, and `*_PROJECT_COMMIT` triple names an
operator-reviewed local Git snapshot whose protected quality policy and
schema-4 candidate CI configuration select exactly that profile. The four
Project names, Project IDs, workspace names, source roots, and source commits
are explicit inputs. Project names, Project IDs, and workspace names must be
pairwise distinct so retained native state and cleanup evidence cannot alias.
The source refs are full `refs/heads/...` names and the commits are complete
lowercase object IDs. The config parser treats every value literally; it does
not evaluate shell, accept commands or SSH options, or accept credential
values. Credential-bearing operator files remain absolute mode-`0600` paths.

Every matrix fixture declares both the ordinary and QEMU candidate jobs. Both
run automatically after proposal push in all four profiles. The protected
policy's `requiredJobs` is recorded separately as the empty, ordinary, QEMU, or
dual quality subset required before checked promotion; it never disables an
unselected candidate job.

`--preflight-only` validates both independent nodes, exact DIM source/package
provenance, all four Project snapshots, private files, stopped service units,
Sysbox, KVM, and fixed images before any installation, Project,
workspace, ref, service, or evidence mutation. The executable's
`--print-command-plan` output is the reviewable installed-command surface.

Every profile creates a ready Project and workspace while both CI host services
remain stopped. In addition, the empty and QEMU-quality profiles verify the installed
ordinary-CI container's complete DIM and Compose ownership labels, immutable
container and image IDs, and logical database digest, then stops only that
exact container ID before Project/workspace creation. It remains stopped through
the readiness observation, then the harness restarts that same ID, waits for
readiness, and requires the durable admission/result state digest to be
unchanged before any CI service starts or proposal is pushed. The digest excludes
only the service-epoch table that activation intentionally rotates on restart.
The QEMU-only profile repeats this
owned outage so its unselected ordinary central service cannot become a hidden
dependency.

All profiles require the owned ordinary central service to be running, start
the ordinary host and QEMU scheduler globally, validate the scheduler's
schema-3 generation-bound database and real `/healthz`, and start the QEMU host before proposal
push. The push automatically publishes envelope schema 2 and event schema 3
for both candidate jobs. The empty profile requires pre-approval promotion
denial and permits interactive human approval plus checked CAS without waiting
for either result; ordinary- and QEMU-quality profiles wait only for their
selected subset; dual waits for both. The harness then waits for both executed
jobs before cleanup so unselected execution remains observable. Every
profile uses a separately named Project/workspace/proposal namespace, requires
the operator to type its complete candidate commit before approval, and records
the source ref/commit, candidate commit/tree, protected ref commit/tree, review,
    executed jobs, quality-required jobs, kind-labelled results, and owned cleanup outcome.

Cleanup discards only the profile's exact workspace and stops only services
started for that profile. A failed central-service restore is a fatal cleanup
failure and cannot be hidden by the exit trap. Foreign, changed, or ambiguous
runtime/state resources remain untouched and make the run fail. Native Project and control-plane state stay
retained for explicit disposable-node destruction. A profile result is first
written to a private temporary file and renamed to `PROFILE-PASSED`; the matrix
result is likewise atomically published as `MATRIX-PASSED` only after all four
profile cleanups succeed. Neither marker is acceptance of
`VERIFICATION-NATIVE-CUTOVER-001`.

The matrix supplies the empty, ordinary-only, QEMU-only, and dual-kind
happy-path evidence missing from the original smoke. Independent-host execution
must still be performed by an operator. Fault-result injection, stale and
replayed evidence denials, crash/restart and reboot recovery, guest-authority
inspection, and effective traffic inspection remain separate unimplemented
full-gate phases. Each run writes `deferred-phase-preparation.json` with fixed
recovery, authority, and traffic evidence requirements and `implemented:false`;
that preparation artifact is traceability, not execution or acceptance.

## Pin the source and the VM owner

Use one reviewed commit and a clean checkout on the host. Do not run the QEMU
guest against an agent's dirty checkout: the trusted launcher snapshots its
entire configured source root (excluding `.git`, `.local`, and `node_modules`),
including other untracked files.

```bash
test "$(git rev-parse HEAD)" = "$EXPECTED_COMMIT"
test -z "$(git status --porcelain=v1 --untracked-files=all)"
docker version --format '{{.Server.Version}}'
docker compose version
test -c /dev/kvm && test -r /dev/kvm && test -w /dev/kvm
docker info --format '{{json .Runtimes}}'
```

The expected commit is the full reviewed root commit, not the agent checkout's
branch name. The trusted host operator must verify that the existing protected
QEMU service's `DIM_QEMU_SOURCE_ROOT` and its root-owned `launcher.bash` were
installed from this checkout through the host's reviewed `.dim/setup.sh`
lifecycle. The client cannot change that source root with `--input`: supplied
inputs are guest data under `/mnt/dim-inputs`, not a replacement workbench.
Inside the agent, the protected socket is mounted at
`/run/dim/qemu-verification/service.sock`. On the host, use the socket recorded
by the reviewed setup (normally `/tmp/dim-qemu-verification/service.sock`) by
setting `DIM_QEMU_VERIFICATION_SOCKET` for the client commands below.
Do not restart, replace, or change permissions on a running protected service
from the agent container. A missing or differently pinned source root blocks
exact-commit VM evidence.

## Install one exact reviewed source revision

The source-install path is the path for this unreleased cutover work. It builds
the package set and trusted workspace image from one commit rather than mixing
published `0.9.0` packages with later source. On every control-plane or worker
host, use the same full commit and aggregate lock:

```bash
set -euo pipefail
EXPECTED_COMMIT=REPLACE_WITH_REVIEWED_40_HEX_COMMIT
git clone --no-checkout https://github.com/slop-lab/dev-infra-manager.git dim-native
cd dim-native
git checkout --detach "$EXPECTED_COMMIT"
test "$(git rev-parse HEAD)" = "$EXPECTED_COMMIT"
test -z "$(git status --porcelain=v1 --untracked-files=all)"
pnpm install --frozen-lockfile
just prepare-local
just install-local
dim --version
dim doctor
```

`just prepare-local` builds all local package tarballs and the trusted image
from that commit and lock; `just install-local` installs that prepared candidate
without rebuilding it. For an already released deployment, use only the exact
matching coordinates `@slop-lab/dim-installer@0.9.0`,
`@slop-lab/dim-cli@0.9.0`, `@slop-lab/dim-core@0.9.0`, and
`@slop-lab/dim-native-git@0.9.0`; do not combine that release with this later
source tree.

Install Sysbox on every workspace or ordinary-worker host and build the
matching workspace image:

```bash
bash verification/scripts/install-host-ubuntu.bash sysbox
dim workspace image build
dim workspace image status
docker info --format '{{json .Runtimes}}' | jq -e 'has("sysbox-runc")'
```

Install the control plane only on its selected host. The installer file is a
caller-owned mode-0600 schema-1 JSON object; both images are immutable registry
digests, and every nested source file is an absolute owner-only path:

```json
{
  "schemaVersion": 1,
  "deploymentId": "native-main",
  "nativeGit": {
    "image": "registry.example/dim-native-git@sha256:REPLACE_WITH_64_HEX",
    "configFile": "/absolute/operator/native-git.json",
    "readinessTokenFile": "/absolute/operator/native-git-readiness.token",
    "publish": {"host": "127.0.0.1", "port": 9080}
  },
  "ordinaryCi": {
    "image": "registry.example/dim-native-ordinary@sha256:REPLACE_WITH_64_HEX",
    "configFile": "/absolute/operator/ordinary-ci.json",
    "readinessTokenFile": "/absolute/operator/ordinary-ci-readiness.token",
    "publish": {"host": "127.0.0.1", "port": 9081}
  }
}
```

```bash
chmod 0600 /absolute/operator/{install,native-git,ordinary-ci}.json \
  /absolute/operator/{native-git-readiness,ordinary-ci-readiness}.token
dim installer install control-plane --config /absolute/operator/install.json
```

The complete strict native Git schema-7 and ordinary format-11 source contracts
are documented in `core/packages/native-git/README.md` and
`core/packages/core/README.md`. Passwords are canonical base64url encodings of
32 random bytes and every role is distinct. They remain only in these private
source files, generated service mounts, and caller-owned role files; they never
enter argv, systemd units, images, workspaces, guests, or retained command
output.

## Bootstrap a reviewed root and create a ready workspace

Create separate registrar, importer, control-plane, and root-read/workspace
issuer files from the operator source config. Keep each file in one mode-0700
directory, mode 0600, owned by the service user, and single-linked. The exact
schemas are `NativeGitProjectRegistrarConnection`,
`NativeGitRootImporterConnection`, and `NativeControlPlaneConnection`; do not
merge their credentials. Bootstrap accepts only the already-local reviewed
repository and one full branch ref:

```bash
set +x
umask 077
OPERATOR_DIR=/absolute/operator/native-project
SOURCE=/absolute/reviewed/project-root
PROJECT=acme
PROJECT_ID=project-a
install -d -m 0700 -- "$OPERATOR_DIR"
test "$(git -C "$SOURCE" rev-parse --verify refs/heads/main^{commit})" = \
  "$(git -C "$SOURCE" rev-parse HEAD)"

dim project bootstrap-native-root "$PROJECT" \
  --project-id "$PROJECT_ID" \
  --source-repository "$SOURCE" \
  --source-ref refs/heads/main \
  --registrar-connection "$OPERATOR_DIR/registrar.json" \
  --importer-connection "$OPERATOR_DIR/importer.json" \
  --git-executable /usr/bin/git --json |
  tee "$OPERATOR_DIR/bootstrap-result.json"
jq -e '.phase == "root-imported" and .projectId == "project-a"' \
  "$OPERATOR_DIR/bootstrap-result.json"

DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE="$OPERATOR_DIR/control-plane.json" \
DIM_NATIVE_ROOT_IMPORTER_CONNECTION_FILE="$OPERATOR_DIR/importer.json" \
  dim project create "$PROJECT" --json |
  tee "$OPERATOR_DIR/project-ready.json"
jq -e '.phase == "ready" and .runnable == true' \
  "$OPERATOR_DIR/project-ready.json"

DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE="$OPERATOR_DIR/control-plane.json" \
  dim workspace create "$PROJECT" work-1
DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE="$OPERATOR_DIR/control-plane.json" \
  dim workspace show work-1 --json
```

Bootstrap output deliberately omits endpoint, username, password, connection
path, authorization data, and import nonce. The source repository may be an
operator's reviewed checkout, but it must not be an agent's dirty worktree.

## Run durable ordinary and QEMU services

The installed commands are foreground processes with `SIGTERM` drain behavior.
Install them as user services on each applicable node; systemd receives only
absolute private config paths, never credential contents:

The installed ordinary service uses exact config schema 5 and strict state
format 12. Earlier admission/registrar fields and state formats are rejected;
eligibility is derived from delivered review events:

<!-- native-cutover-smoke-fixture:ordinary-service -->
```json
{
  "schemaVersion": 5,
  "serviceId": "ordinary-main",
  "database": "/var/lib/dim-ordinary-ci/ordinary-ci.sqlite3",
  "eligibilityLeaseMilliseconds": 300000,
  "claimLeaseMilliseconds": 60000,
  "nativeGit": {
    "endpoint": "http://native-git:8080",
    "serviceId": "native-main",
    "identity": {"username": "ordinary-identity", "password": "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE"},
    "attemptIssuer": {"username": "ordinary-attempts", "password": "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI"},
    "candidateReader": {"username": "ordinary-candidate", "password": "AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM"},
    "resultReporter": {"username": "ordinary-results", "password": "BAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ"}
  },
  "credentials": {
    "webhook": {"username": "ordinary-events", "password": "BQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU"},
    "query": {"username": "ordinary-query", "password": "BgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgY"}
  },
  "hosts": [{
    "hostId": "ordinary-a",
    "hostToken": "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc",
    "capacities": [{
      "capacity": "ordinary-a-1",
      "runnerBaseImage": "registry.example/ordinary-runner@sha256:6666666666666666666666666666666666666666666666666666666666666666",
      "jobBaseImage": "registry.example/job@sha256:7777777777777777777777777777777777777777777777777777777777777777",
      "bounds": {"cpu": "2", "memoryBytes": "4294967296", "pids": "1024", "wallClockSeconds": "1800", "outputBytes": "10485760"}
    }]
  }]
}
```

The service state marker records `stateFormat: 12`, and its SQLite database
uses `PRAGMA user_version=12`. The harness checks both before using or stopping
the owned central service.

The ordinary host file is exact schema 1. Its `capacities` names are fixed
operator capacity IDs, all paths are absolute, and every credential is distinct:

<!-- native-cutover-smoke-fixture:ordinary-host -->
```json
{
  "schemaVersion": 1,
  "hostId": "ordinary-a",
  "generationId": "0000000000000000000000000000000000000000000000000000000000000000",
  "stateDirectory": "/absolute/state/native-ordinary-host",
  "gitExecutable": "/usr/bin/git",
  "ordinaryCi": {
    "transport": "https",
    "endpoint": "https://ordinary.example",
    "serviceId": "ordinary-main",
    "credential": {"username": "ordinary-a", "password": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}
  },
  "nativeGit": {
    "transport": "https",
    "endpoint": "https://native-git.example",
    "serviceId": "native-main"
  },
  "capacities": ["ordinary-a-1"]
}
```

The QEMU host file is also exact schema 1. Both scheduler and native-Git
transports support HTTPS. The smoke fixture keeps native Git loopback because
the QEMU worker is deliberately control-local:

<!-- native-cutover-smoke-fixture:qemu-host -->
```json
{
  "schemaVersion": 1,
  "hostId": "qemu-a",
  "generationId": "1111111111111111111111111111111111111111111111111111111111111111",
  "gitExecutable": "/usr/bin/git",
  "scheduler": {
    "transport": "https",
    "endpoint": "https://qemu-scheduler.example",
    "serviceId": "qemu-main",
    "hostToken": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
  },
  "nativeGit": {
    "transport": "loopback-http",
    "endpoint": "http://127.0.0.1:9080",
    "serviceId": "native-main"
  },
  "capacities": [{
    "capacity": "qemu-a-1",
    "runnerBaseImage": "registry.example/qemu-runner@sha256:8888888888888888888888888888888888888888888888888888888888888888",
    "jobBaseImage": "registry.example/job@sha256:9999999999999999999999999999999999999999999999999999999999999999",
    "cpus": 4,
    "memoryBytes": 8589934592,
    "supervisorMemoryBytes": 9663676416,
    "pids": 2048,
    "timeoutSeconds": 1800,
    "outputBytes": 10485760
  }]
}
```

The target scheduler has exactly four native-Git credentials, including the candidate
reader, plus event-intake and query credentials. Every username,
password, and host token is globally distinct:

<!-- native-cutover-smoke-fixture:qemu-scheduler -->
```json
{
  "schemaVersion": 2,
  "serviceId": "qemu-main",
  "host": "127.0.0.1",
  "port": 9090,
  "database": "/absolute/state/native-qemu-scheduler.sqlite3",
  "eligibilityLeaseMilliseconds": 300000,
  "claimLeaseMilliseconds": 60000,
  "nativeGit": {
    "endpoint": "http://127.0.0.1:9080",
    "serviceId": "native-main",
    "identity": {"username": "qemu-identity", "password": "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE"},
    "attemptIssuer": {"username": "qemu-attempts", "password": "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI"},
    "candidateReader": {"username": "qemu-candidate", "password": "AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM"},
    "resultReporter": {"username": "qemu-results", "password": "BAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ"}
  },
  "credentials": {
    "eventIntake": {"username": "qemu-events", "password": "BQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU"},
    "query": {"username": "qemu-query", "password": "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc"}
  },
  "hosts": [{
    "hostId": "qemu-a",
    "hostToken": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "capacities": [{
      "capacity": "qemu-a-1",
      "runnerBaseImage": "registry.example/qemu-runner@sha256:8888888888888888888888888888888888888888888888888888888888888888",
      "jobBaseImage": "registry.example/job@sha256:9999999999999999999999999999999999999999999999999999999999999999",
      "bounds": {"cpu": "4", "memoryBytes": "8589934592", "pids": "2048", "wallClockSeconds": "1800", "outputBytes": "10485760"}
    }]
  }]
}
```

The scheduler database is strict schema 3 (`PRAGMA user_version=3`). Its
`native_qemu_metadata` table contains exactly `execution_authority_json`,
`schema_version=3`, and a lowercase RFC 4122 version-4
`service_generation_id`. The authority value is the canonical JSON of hosts
and capacities sorted by ID, including images and bounds but excluding host
tokens and credentials. The harness requires a byte-exact match to the current
config before accepting `/healthz` and records both the non-secret authority
and generation ID in readiness evidence. A stale config field such as `listen`,
a schema-1 or schema-2 database, missing or mismatched authority metadata, or a
malformed generation ID fails before proposal push.

`NativeOrdinaryBundleConfig`, `NativeRootCiHostConfig`,
`NativeQemuConnection`, and `NativeQemuSchedulerConfig` are strict. Replace
every example secret and digest as one coherent set, and store all files as
caller-owned, single-link mode-0600 files.
The QEMU host's `memoryBytes` is guest RAM. Set `supervisorMemoryBytes` to a
strictly larger operator limit that includes QEMU, kernel/initramfs, and
supervisor overhead; an equal or smaller value is rejected before service
contact.

```bash
set -euo pipefail
UNIT_DIR="$HOME/.config/systemd/user"
ORDINARY_HOST_CONFIG=/absolute/operator/ordinary-host.json
QEMU_SCHEDULER_CONFIG=/absolute/operator/qemu-scheduler.json
QEMU_HOST_CONFIG=/absolute/operator/qemu-host.json
QEMU_HOST_ID=qemu-a
install -d -m 0700 -- "$UNIT_DIR"

cat >"$UNIT_DIR/dim-native-root-host.service" <<EOF
[Unit]
Description=DIM native ordinary Sysbox host
After=docker.service network-online.target

[Service]
Type=simple
UMask=0077
Environment=PATH=%h/.local/bin:%h/.local/share/mise/shims:/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/bin/env dim ci native-root host run $ORDINARY_HOST_CONFIG
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF

cat >"$UNIT_DIR/dim-native-qemu-scheduler.service" <<EOF
[Unit]
Description=DIM native QEMU scheduler
After=network-online.target

[Service]
Type=simple
UMask=0077
Environment=PATH=%h/.local/bin:%h/.local/share/mise/shims:/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/bin/env dim ci native-qemu scheduler run $QEMU_SCHEDULER_CONFIG
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF

cat >"$UNIT_DIR/dim-native-qemu-host.service" <<EOF
[Unit]
Description=DIM native QEMU host $QEMU_HOST_ID
After=docker.service network-online.target

[Service]
Type=simple
UMask=0077
Environment=PATH=%h/.local/bin:%h/.local/share/mise/shims:/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/bin/env dim ci native-qemu host run $QEMU_HOST_ID $QEMU_HOST_CONFIG
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now dim-native-root-host.service
systemctl --user enable --now dim-native-qemu-scheduler.service
systemctl --user enable --now dim-native-qemu-host.service
systemctl --user --no-pager status dim-native-root-host.service \
  dim-native-qemu-scheduler.service dim-native-qemu-host.service
```

The installed host CLI exposes the three long-running `run` commands above;
it does not expose a separate host-readiness or host-status subcommand. Use
systemd status and journals for process health. The implemented result-query
surface is review inspection for ordinary jobs and
`dim ci native-qemu event status` for a known QEMU event ID.

Enable lingering explicitly if these services must survive logout:

```bash
sudo loginctl enable-linger "$USER"
loginctl show-user "$USER" -p Linger
```

Before enabling the ordinary unit, verify Docker reports `sysbox-runc`; the
command performs the same gate and refuses claims when it is unavailable.
Before enabling the QEMU host unit, run:

```bash
test -c /dev/kvm && test -r /dev/kvm && test -w /dev/kvm
qemu-system-x86_64 -enable-kvm -machine none -nodefaults -display none
```

The QEMU host command also probes KVM on the host and inside every pinned runner
image before attestation. The same preflight performs a real Docker
`type=image` mount of each pinned job image and requires its `/bin/bash`,
`/dev`, `/proc`, `/sys`, `/run/dim/job`, and `/workspace`. Docker 29 image-mount
support is therefore required. The trusted QEMU supervisor does not require
Sysbox. A missing or nonfunctional KVM device is unavailable, never a passing
or ordinary result. Do not use TCG as a substitute.

Start globally configured nodes only after their private files and services
exist. Trusted native Project registration makes the Project eligible
automatically. The old `dim ci native-root project admit` and `dim ci
native-qemu project admit` commands are obsolete targets to remove, not
compatible aliases. Operators don't register or refresh each Project. After an
outage, the services reconcile internally and resume durable queued proposal
work while preserving generation, lease, and owned-cleanup fences.

### Network truth

The installed services do not terminate TLS. Loopback HTTP is valid only on
one host. A remote ordinary worker may use the schema's `https` transport only
through an operator-managed TLS reverse proxy whose certificate is trusted by
the host Node.js runtime; there is no custom-CA or client-certificate flag.
external terminator. The QEMU host's native-Git connection supports the same
operator-managed HTTPS model. This smoke nevertheless requires loopback HTTP
for that connection and keeps the QEMU worker with the control plane; it proves
an independent ordinary worker node, not a three-node deployment.

## Discover reviews, jobs, and results

Push the workspace-scoped proposal and resolve the immutable envelope that
native Git created automatically. Retain its review ID as the result-discovery
root. `inspect` returns current approval state plus kind-labelled ordinary and
QEMU attempt/status evidence without returning credentials:

```bash
dim-native-git operator review resolve "$OPERATOR_DIR/reviewer.json" \
  "$PROJECT_ID" refs/heads/proposals/WORKSPACE_ID/change-1 |
  tee "$OPERATOR_DIR/review.json"
REVIEW_ID="$(jq -er '.review.reviewId' "$OPERATOR_DIR/review.json")"
dim-native-git operator review inspect "$OPERATOR_DIR/reviewer.json" \
  "$PROJECT_ID" "$REVIEW_ID" | tee "$OPERATOR_DIR/review-status.json"

dim ci native-qemu event status EVENT_ID "$QEMU_SCHEDULER_CONFIG" |
  tee "$OPERATOR_DIR/qemu-event-status.json"
journalctl --user -u dim-native-root-host.service \
  -u dim-native-qemu-host.service --since today
```

There is no ordinary event-list command. Review inspection is the installed
operator surface for delivered ordinary terminal evidence; the QEMU scheduler
adds event-level claim/attempt/result status when its event ID is known.

## Checks available today

From the clean checkout, with the pinned pnpm dependencies and Docker 29.1.3:

```bash
pnpm install --frozen-lockfile
pnpm run workspace:build
just verify native-idle-service-images
just verify control-plane-install-live
node .dim/qemu-client.mjs status
node .dim/qemu-client.mjs probe
```

The first two verification recipes build actual digest-pinned native Git and
ordinary CI service images and exercise private configuration, readiness,
activation, isolation, exact owned cleanup, installer facade deployment,
incompatible updates, rollback, and fail-closed authority tests. They need a
reachable Docker daemon and Compose, free DIM control-plane resource names, and
enough temporary registry/image capacity. They do **not** launch a Sysbox job
or native QEMU job. `probe` uses the protected host socket to start the host's
real QEMU/KVM executable briefly; it is not a guest boot or a job result.

When the host's protected source root is confirmed to be this exact clean
commit, an operator may additionally run:

```bash
node .dim/qemu-client.mjs run
node .dim/qemu-client.mjs status
```

That launches a disposable Ubuntu guest and runs the existing Sysbox/KVM host
installation and full-development smoke. Its `kvm-host-install-smoke-ok: sysbox`
terminal output proves the existing backend gate only. The workbench smoke
still exercises predecessor Gitea development paths; do not count it as a
Gitea-free native CI or protected-promotion result. If using a standalone clean
host instead of the protected service, run
`bash verification/scripts/install-kvm-verify-deps-ubuntu.bash` and
`just verify environments-kvm` there, not inside the agent container.

The bootstrap and create commands above now cover source-to-imported-draft and
imported-draft-to-ready. Global CI services discover the resulting registered
Project internally; these commands don't register a runner or admit a Project
to CI. Do not place any
connection file in a guest, workspace, container image, or diagnostic log.

## Prove installed review and protected promotion

Run this only after the exact installed Project has a proposal ref and its
policy-selected ordinary and QEMU jobs, if any, have current delivered success
evidence. The installer intentionally does not copy operator credentials out of
the reviewed native-Git service config. Create separate caller-owned connection
files without putting passwords in argv, shell variables, command output, or
logs:

```bash
set -euo pipefail
set +x
umask 077
NATIVE_CONFIG=/absolute/operator/native-git.json
NATIVE_ENDPOINT=http://127.0.0.1:7443
GENERATION_ID=REPLACE_WITH_INSTALLER_REPORTED_64_HEX_GENERATION
HOST_ID=host-a
REVIEWER_ID=owner
OPERATOR_DIR=/absolute/operator/native-review
EVIDENCE_DIR=/absolute/operator/native-review-evidence
install -d -m 0700 -- "$OPERATOR_DIR" "$EVIDENCE_DIR"

jq --arg endpoint "$NATIVE_ENDPOINT" --arg generation "$GENERATION_ID" --arg host "$HOST_ID" '
  .hostPromoters[] | select(.hostId == $host) |
  {schemaVersion:1, role:"host-promoter", serviceId:"native-main",
   endpoint:$endpoint, generationId:$generation, username, password}
' "$NATIVE_CONFIG" >"$OPERATOR_DIR/promoter.json"
jq --arg endpoint "$NATIVE_ENDPOINT" --arg generation "$GENERATION_ID" --arg reviewer "$REVIEWER_ID" '
  .humanReviewers[] | select(.reviewerId == $reviewer) |
  {schemaVersion:1, role:"human-reviewer", serviceId:"native-main",
   endpoint:$endpoint, generationId:$generation, username, password}
' "$NATIVE_CONFIG" >"$OPERATOR_DIR/reviewer.json"
chmod 0600 "$OPERATOR_DIR/promoter.json" "$OPERATOR_DIR/reviewer.json"
test "$(stat -c '%a:%h:%u' "$OPERATOR_DIR/promoter.json")" = "600:1:$(id -u)"
test "$(stat -c '%a:%h:%u' "$OPERATOR_DIR/reviewer.json")" = "600:1:$(id -u)"
```

Use the CLI built from the same reviewed checkout. Substitute the real Project
and canonical proposal ref. Do not enable shell tracing.

```bash
native_git_cli=(node "$PWD/core/packages/native-git/dist/cli.js")
PROJECT=REPLACE_WITH_PROJECT
PROPOSAL_REF=refs/heads/proposals/REPLACE_WITH_43_CHARACTER_WORKSPACE_ID/change-1
CONTAINER=dim-control-plane-native-git-1

before="$("${native_git_cli[@]}" operator review resolve \
  "$OPERATOR_DIR/reviewer.json" "$PROJECT" "$PROPOSAL_REF" | tee "$EVIDENCE_DIR/review-resolve.json" | jq -r '.review.expectedProtectedHead')"
review_id="$(jq -r '.review.reviewId' "$EVIDENCE_DIR/review-resolve.json")"
test -n "$review_id" && test "$review_id" != null
ref_before="$(docker exec --user 10001:10001 "$CONTAINER" \
  git --git-dir "/var/lib/dim-native-git/$PROJECT/root.git" rev-parse refs/heads/main)"
test "$before" = "$ref_before"

if "${native_git_cli[@]}" operator review promote \
  "$OPERATOR_DIR/promoter.json" "$PROJECT" "$review_id"; then
  printf 'promotion unexpectedly succeeded before approval/evidence gate\n' >&2
  exit 1
fi
test "$(docker exec --user 10001:10001 "$CONTAINER" \
  git --git-dir "/var/lib/dim-native-git/$PROJECT/root.git" rev-parse refs/heads/main)" = "$ref_before"

"${native_git_cli[@]}" operator review inspect \
  "$OPERATOR_DIR/reviewer.json" "$PROJECT" "$review_id" | jq .
"${native_git_cli[@]}" operator review approve \
  "$OPERATOR_DIR/reviewer.json" "$PROJECT" "$review_id" | jq .
"${native_git_cli[@]}" operator review promote \
  "$OPERATOR_DIR/promoter.json" "$PROJECT" "$review_id" | tee "$EVIDENCE_DIR/promotion.json" | jq .

candidate="$(jq -r '.candidateCommit' "$EVIDENCE_DIR/promotion.json")"
ref_after="$(docker exec --user 10001:10001 "$CONTAINER" \
  git --git-dir "/var/lib/dim-native-git/$PROJECT/root.git" rev-parse refs/heads/main)"
test "$ref_after" = "$candidate"
test "$ref_after" != "$ref_before"
docker exec --user 10001:10001 "$CONTAINER" node --input-type=module -e '
  import { DatabaseSync } from "node:sqlite";
  const database = new DatabaseSync("/var/lib/dim-native-git/native-idle.sqlite3", {readOnly:true});
  const project = process.argv[1];
  const intent = database.prepare("SELECT count(*) count FROM native_project_root_promotion_intent WHERE project_id = ?").get(project);
  const finalized = database.prepare("SELECT sequence, candidate_commit FROM native_project_root_promotion_finalized WHERE project_id = ? ORDER BY sequence").all(project);
  console.log(JSON.stringify({intent:intent.count, finalized}));
' "$PROJECT" | tee "$EVIDENCE_DIR/promotion-ledger.json"
test "$(jq -r '.intent' "$EVIDENCE_DIR/promotion-ledger.json")" = 0
test "$(jq -r '.finalized[-1].candidate_commit' "$EVIDENCE_DIR/promotion-ledger.json")" = "$ref_after"
```

The failed request is the red proof: the protected ref must remain unchanged.
The successful request is green only when the response candidate, real Git ref,
and final durable ledger row agree and no intent remains. Retain the JSON
responses, ref values, image digests, exact commit, and credential-free ledger
output as evidence. Delete temporary response files after evidence collection;
keep the connection files and evidence only in their operator-owned mode-`0700`
directories.

## The full cutover gate remains unimplemented

`VERIFICATION-NATIVE-CUTOVER-001` must not pass until a disposable Sysbox+KVM
host observes all of these
in one exact-commit installation, without a Gitea service or fallback:

1. Native Project/root registration, workspace creation, pinned protected-root
   snapshot, proposal-only Git push, and direct protected-ref write denial.
   Project and workspace readiness must succeed before CI runs and remain valid
   while ordinary and QEMU services are unavailable.
2. A real ordinary Sysbox host claim, bounded execution, owned cleanup,
   acknowledged terminal evidence, and capacity release.
3. A separate native-QEMU scheduler and real KVM guest job, with its own
   claim/result proof and no ordinary-evidence substitution.
4. Current human approval plus a checked protected-ref compare-and-swap. The
   dual-kind acceptance Project must also require both CI results through its
   quality policy; stale head, policy, review, or selected evidence must leave
   the ref unchanged. Separate empty, ordinary-only, and QEMU-only quality
   cases must not wait for an unselected kind.
5. Guest inspection for absent host sockets, `/dev/kvm`, raw secrets, promotion
   credentials, and cross-Project data; evidence of reboot and recovery.

The internal `admission-pending` stage grants none of these rights. The packaged
clean-host smoke proves only the dual-kind happy path, proposal/ref denials,
human approval, protected-ref compare-and-swap, and owned-claim cleanup. It does
not prove all policy variants, wrong-kind/failed/stale/replayed evidence denials,
crash/restart recovery, host reboot recovery, guest authority absence, or
traffic boundaries. Do not replace those remaining phases with the
predecessor ordinary pool, shared Gitea-QEMU scheduler, a synthetic job, or
idle-service readiness. Preserve the exact commit, image digests, guest logs,
and service result proofs without copying credentials into the evidence.
Native policy and schema-4 candidate config accept empty, ordinary-only,
QEMU-only, and dual-kind job selections; readiness itself does not wait for any
selection.

This runbook's ordinary plus QEMU journey is a deployment smoke, not acceptance
and not a claim that both kinds are security prerequisites. Native readiness,
promotion security, and optional CI quality are independent gates. No runner,
scheduler, or result identity may approve or promote.
