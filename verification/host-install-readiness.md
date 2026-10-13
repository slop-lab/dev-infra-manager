# Host installation and real-use readiness

## Status and scope

The recommended environment is implemented and locally verified, but its
complete installed Sysbox workspace journey is **not yet accepted on a capable
host**. The current development container has only runc Docker runtimes and no
access to the retained host-side VM lab. Do not substitute runc for the agent's
Sysbox isolation gate.

There are only two environment contracts:

- No custom lifecycle files: DIM supplies the recommended environment.
- Reviewed `.dim/setup.sh`, `.dim/entrypoint.sh`, `.dim/docker-compose.yml`, or
  `.dim/teardown.sh`: the Project supplies real custom lifecycle behavior and
  need not follow the common agent/DinD topology.

There is no minimal preset or general environment-selector format.
`.dim/environment.yml` and persisted `environment: minimal` state are rejected,
not silently converted. Rejection does not rewrite existing state or delete
user data.

Basic workspace use does not require QEMU, native CI, or package publication.
Gitea-free use additionally requires the native Git deployment and explicit
review-policy provisioning described below.

## Evidence already available

- This removal passed workspace type checks/builds, 214 workspace/native-lifecycle
  regression tests, and a post-fix driver exercising recommended selection, actual custom hooks,
  and obsolete-selector rejection.
- Before this removal, the recommended-default candidate passed the complete
  core suite with 1,847 passing tests and two skips, plus 15 real native
  bootstrap CLI tests. These are earlier-candidate results, not a claim that
  the full suite was rerun for this removal.
- Release Docker image tooling and the owned relay were executed locally,
  including Alpine lock behavior, fixed-origin HTTP/TLS forwarding, phase
  gating, process reuse, and cleanup. This does not prove Sysbox isolation.
- Earlier native idle-image and installer Docker gates passed install, update,
  rollback, recovery, and owned-resource cleanup on their recorded candidates.
- The supplied independent-VM report covers unmodified `c46434b4`: both Ubuntu
  nodes installed the same artifact, ran Sysbox, and reported functional nested
  KVM. Native jobs were blocked by the nonterminating readiness probe. The
  `19d3a3f1` fix and later recommended-environment commits have not been
  reinstalled and accepted in those VMs.

## P0: install and use the current basic workspace on a capable host

### Source and QEMU prerequisites are separate profiles

Run the source gate without installing its pinned toolchain on the host:

```bash
bash verification/scripts/source-gate-container.bash
```

The complete source suite uses an integration fixture pinned to
`/usr/bin/git` 2.43.0, Node.js 24/26, and pnpm 10.13.1. It also includes
root-owned ownership fixtures. `just check-source` builds and runs that suite
in its pinned disposable container, without mounting the checkout writable or
passing the host Docker socket. It needs no host pnpm, Git downgrade, or sudo.
The current worktree is copied without generated state or conventional
credentials; submit only reviewed source without other secret-bearing files.
Network access remains available for installer tests. The gate uses its exact
built image ID and retains the complete recursive source suite. Real Docker
executor checks remain under `just verify native-ordinary-executor-live` and
require Sysbox plus explicit digest-pinned fixture images; missing capability
is unavailable, not success.

Use `just check-source-native` only inside an already pinned environment.
A PATH Git shim does not satisfy its absolute fixture binary contract. Its
preflight aggregates toolchain, temporary-directory ancestry, ownership
capability, and optional distribution-artifact errors. Both paths build test
dependencies before testing. Use `just typecheck` for compiler-only feedback
on an ordinary supported Node.js host.

Prepare QEMU separately on the reviewed amd64 Ubuntu host, with explicit
confirmation of package, Node, and group changes:

```bash
bash verification/scripts/install-kvm-verify-deps-ubuntu.bash
newgrp kvm
```

Inside the refreshed normal-user shell:

```bash
export DIM_QEMU_NODE_EXECUTABLE=/usr/local/lib/dim-qemu-node-24.19.0/bin/node
sudo -v
bash verification/scripts/kvm-host-install-smoke.bash --preflight-only
just verify environments-kvm
```

The installer verifies a fixed checksum for Node.js 24.19.0, installs it under
a dedicated root-owned path, and leaves `/usr/local/bin/node` and user-managed
Node trees untouched. It configures persistent KVM group membership, not
world-writable device permissions. Physical KVM availability and operator sudo
approval still require the actual host; this procedure does not claim they
were exercised by a source-only container run.

The QEMU gate instead runs as the normal host operator. Its preflight reports
trusted-interpreter, non-root user, sudo authorization, setpriv, KVM access, and
QEMU/dependency problems together without starting a service. Select a genuine
reviewed Node.js 24/26 executable under a root-owned, non-writable directory
tree with `DIM_QEMU_NODE_EXECUTABLE`; do not change ownership of a mise/nvm/home
installation to bypass this boundary. Operator-run `sudo -v` may establish
cached authorization for the later narrowly scoped `sudo -n` commands. A
permanent blanket `NOPASSWD` rule is not required.

1. **Prepare the host.** Use a disposable Linux host or retained VM with a
   systemd user manager, reachable Docker 29, registered `sysbox-runc`, working
   cgroup enforcement, and Docker Buildx. Review the host installer before
   changing host packages. Leave host memory/CPU headroom beyond the workspace
   budgets, especially when optional CI supervisors run concurrently. KVM is
   optional for this basic journey.
2. **Build one immutable candidate.** Use a clean checkout of the commit
   containing this document, not an old prepared bundle or a dirty archive:

   ```bash
   CANDIDATE_SHA="$(git rev-parse HEAD)"
   DIM_SOURCE_ROOT_COMMIT="$CANDIDATE_SHA" just prepare-local
   just install-local
   DIM_CLI="${XDG_DATA_HOME:-$HOME/.local/share}/dim/runtime/current/node_modules/.bin/dim"
   "$DIM_CLI" --version
   "$DIM_CLI" doctor
   "$DIM_CLI" workspace image status
   ```

   Preparation creates a matched package/image candidate. Installation consumes
   it, activates the local plugin set, and restarts the controller through the
   target installer. Retain `.local/prepared-local.state`, package hashes,
   image ID, installed version, and doctor output. If transferring to another
   node, transfer the identical prepared artifacts and verify those identities.
   Do not include VM disks, SSH private keys, or operator secrets in public
   evidence or package transfers.
   Public npm publication is not required for this trial.
   `install-local` deliberately uses `--no-local-bin`; it does not promise a
   fresh host has a bare `dim` on `PATH`. Use the installed runtime path above
   for later example commands, or an already reviewed facade/symlink. Node.js
   24 or 26 must be on `PATH`; with mise-managed tools, activate that environment
   or invoke the path through `mise exec --`.
3. **Execute the installed no-`.dim` journey.** Follow the
   [recommended-default example](../examples/projects/recommended-default/README.md).
   Its `project create --root ...` example uses the existing managed-Git path;
   it is not evidence of Gitea-free adoption. Check real `create`, `run shell`,
   `run exec`, `run custom`, and `workspace exec`, plus Git fetch and proposal
   push from the agent. Verify nested Docker actually starts.
4. **Exercise persistence and failures.** Write checkout/home data and create
   private-Docker data; stop/start, restart the controller, and replace the
   agent image without losing it. Advance the reviewed root and verify mutable
   HEAD/files remain unchanged until explicit user Git operations. Check setup
   retry, error/stopped write denial, resource-update rollback, custom-mode
   transition refusal, and discard of only owned resources.
5. **Measure the boundary.** Verify actual Sysbox runtime/UID behavior, absence
   of host/Project Docker sockets and raw credentials, and real CPU, memory,
   swap, and PID enforcement. The recorded combined budget is partitioned
   25% outer / 75% agent; argument inspection alone is not kernel enforcement.
6. **Install an agent tool explicitly if needed.** Provider installation and
   login are not automatic. Execute the reviewed tool setup helper and provider
   commands in the agent, without adding `.dim` solely to launch a tool. Test
   normal interactive and redirected command input with the chosen tool.

The raw-container script
`verification/scripts/recommended-workspace-sysbox-smoke.bash` supplies a
component gate. It does not replace steps 3-6 or constitute the full installed
DIM CLI journey.

### Diagnose both nested Docker paths before the full journey

On the target host, use the **exact installed workspace image reference** from
`dim workspace image status` and a digest-pinned probe image already present in
that host's Docker image store. The diagnostic refuses a missing image instead
of pulling or mutating host Docker storage:

```bash
docker image inspect 'alpine@sha256:REPLACE_WITH_HOST_CACHED_DIGEST'
bash verification/scripts/native-workspace-nested-docker-diagnostic.bash \
  'dev-infra-project-workspace:REPLACE_WITH_EXACT_PREPARED_VERSION' \
  'alpine@sha256:REPLACE_WITH_HOST_CACHED_DIGEST'
```

It runs the trusted outer runc lane and the recommended Sysbox agent lane
independently in disposable, ownership-labelled containers/volumes. Both must
load the same exported image from the host cache and actually run an inner
container. It records each lane's driver, backing filesystem, image store,
cgroup settings, runtime data root, failure stage, and the daemon's error; a
failure in one lane does not hide the other. `PASS` means nested image execution
worked for that lane, `FAIL` reports the stage/error, `IMAGE_UNAVAILABLE` means
the exact images need provisioning, and `UNAVAILABLE` means the runtime or host
Docker was absent. The aggregate exits nonzero unless both lanes pass. It does
not repair or delete an existing Docker data root.

The runc lane now explicitly uses the production
`DIM_DOCKERD_FLAGS=--feature containerd-snapshotter=false` profile and a named
volume at `/var/lib/dim/workspace-data`; expect classic `overlay2` there. The
Sysbox lane keeps the agent's own daemon profile. The earlier both-lane PASS
with `overlayfs`/containerd did not prove the production runc profile. Likewise,
the corrected `container-inner-docker-smoke.bash` no longer places the initial
nested Docker data root in the outer writable overlay layer or forces an
unsupported `overlayfs` storage driver. A local backing-device contrast proved
those paths differ; the capable host must still verify whether this corrects
its earlier mount error.

After the diagnostic, run the full standalone smoke without treating the
diagnostic as a replacement:

```bash
DIM_CONTAINER_TEST_IMAGE='alpine@sha256:REPLACE_WITH_HOST_CACHED_DIGEST' \
  bash verification/scripts/container-inner-docker-smoke.bash
```

This gate additionally checks network access, immutable-root replacement,
cached inner-image execution, and data ownership persistence. Its success
marker is emitted only after owned cleanup succeeds.

The development agent's runc-only daemon currently reports a cgroup permission
error at `nested-image-run`; the earlier capable host report describes an
overlay-mount `invalid argument`. These are observations from different hosts,
not a confirmed common cause. Preserve both outputs, inspect fresh disposable
volumes and the reported storage backing before changing any daemon setting.

## P1: integrations needed by the chosen real-use profile

- **Resource and development-URL helpers:** the recommended agent currently
  receives neither `DIM_AGENT_CONTROLLER_SOCKET` nor
  `DIM_DEVELOPMENT_URL_SOCKET`. Installed helper binaries are not evidence that
  these interfaces are wired into the default environment. Connect and test
  narrow agent-audience proxies before promising assigned-resource discovery
  or in-agent development-URL requests. Do not mount an admin socket/token as a
  shortcut. A host-side development-URL workflow requires configured ingress
  and approval separately.
- **Backups and mode changes:** recommended `discard --keep-volume` is refused
  before mutation. A supported export/restore or identity-safe volume handoff
  is additional work if that workflow is required; until then retain the
  workspace or explicitly back up needed data before discard.
- **Gitea-free adoption:** provision the native Git/ordinary service bundle,
  separate private operator role files, serving-generation connection files,
  and TLS where remote HTTPS is used. Bootstrap a no-`.dim` repository with
  an explicit external `--review-policy`, then execute the P0 workspace journey
  through native Git. No implicit empty review policy or automatic approval is
  permitted.

## P2: native CI and full cutover acceptance

These are not prerequisites for a basic workspace:

1. Reinstall the current exact candidate on both independent nodes and rerun
   the fixed host and runner-image KVM readiness probes. Prove normal completion,
   cancellation failure, timeout failure, and owned cleanup; a QMP capability
   probe is not a completed CI job.
   The repository QEMU gate additionally needs a non-root invoking user,
   cached `sudo -n` authorization for the narrowly staged root service, an
   absolute canonical non-symlink root-owned mode-`0755` Node.js 24 or 26
   interpreter under root-owned non-writable ancestors, and `/usr/bin/setpriv`.
   Prime normal operator authorization with `sudo -v`; a permanent blanket
   `NOPASSWD` rule is not required. Select a reviewed system/vendor Node
   installation with `DIM_QEMU_NODE_EXECUTABLE`; never trust a mise, nvm, or
   home-directory Node tree by changing its ownership. Run `--preflight-only`
   first to report all host deficiencies without creating service state. Run
   the gate as that user, never as root. Test both a normal run and an actual
   `--input NAME=PATH`
   run, including guest reads as UID 1001; local staging/readability tests are
   not a substitute for the guest test.
2. Provision global ordinary/QEMU service role files, units, immutable images,
   registry and transport trust, and the four Project policy fixtures. Verify
   Docker `type=image` support on the execution host. Those operator inputs
   were not created in the supplied VM report.
3. Run both the native dual-kind smoke and empty/ordinary/QEMU/dual policy
   matrix using [the native host runbook](native-cutover-host.md). Keep the
   interactive exact-commit human approval and checked promotion step intact.
4. Complete the still-unimplemented full-gate phases: failure/stale/wrong-kind
   and replay denials, process/host crash and reboot recovery, guest-authority
   inspection, and effective traffic inspection. Neither `SMOKE-PASSED` nor
   `MATRIX-PASSED` satisfies `VERIFICATION-NATIVE-CUTOVER-001`.
5. Legacy Gitea paths still exist. Remove/reconcile them and finish the full
   native acceptance contract before claiming complete core Gitea removal.

## Separate release/publication work

Public package publication, canonical-source publication, tags, signed release
artifacts, Node.js 24/26 matrix, and independent release workflows follow
[the releasing contract](../specification/docs/releasing.md). They are separate
from trying an exact locally packed candidate on a host. None is authorized or
reported as completed by this readiness checklist.
