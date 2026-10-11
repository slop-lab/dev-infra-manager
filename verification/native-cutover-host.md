# Native cutover host verification

This is an operator runbook for a **disposable Linux host**. It separates
working Gitea-free service and host-capability checks from the still-unavailable
`VERIFICATION-NATIVE-CUTOVER-001` acceptance journey in
`specification/specs/12-verification.md`. A successful image, installer, or KVM
probe does **not** mean that Project workspaces, CI jobs, or promotion work.

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

With a trusted, already `root-imported` schema-2 native Project draft and
private operator-owned mode-`0600` connection files, the *non-runnable* native
Project checkpoint can be inspected through the loopback-HTTP native service
(pending creation does not yet support an HTTPS importer):

```bash
DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE=/absolute/operator/control-plane.json \
DIM_NATIVE_ROOT_IMPORTER_CONNECTION_FILE=/absolute/operator/root-importer.json \
  dim project create PROJECT --json
DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE=/absolute/operator/control-plane.json \
  dim project list --json
```

The returned record must say `phase: admission-pending` and `runnable: false`.
This command does not bootstrap the draft, create a workspace, or advertise CI.
Do not place either connection file in a guest, workspace, container image, or
diagnostic log.

## The cutover gate is still blocked by implementation

`VERIFICATION-NATIVE-CUTOVER-001` must not pass until the native Project reaches
a genuinely ready state and a disposable Sysbox+KVM host observes all of these
in one exact-commit installation, without a Gitea service or fallback:

1. Native Project/root registration, workspace creation, pinned protected-root
   snapshot, proposal-only Git push, and direct protected-ref write denial.
2. A real ordinary Sysbox host claim, bounded execution, owned cleanup,
   acknowledged terminal evidence, and capacity release.
3. A separate native-QEMU scheduler and real KVM guest job, with its own
   claim/result proof and no ordinary-evidence substitution.
4. Current human approval plus both required CI kinds before a checked
   protected-ref compare-and-swap; stale head, policy, review, or evidence must
   leave the ref unchanged.
5. Guest inspection for absent host sockets, `/dev/kvm`, raw secrets, promotion
   credentials, and cross-Project data; evidence of reboot and recovery.

The installed `admission-pending` record does not grant any of these rights.
The native workspace adapter, installed ordinary host executor, independent
native-QEMU execution/evidence, dual-kind promotion, and one packaged
clean-host journey remain to be implemented. Do not replace them with the
predecessor ordinary pool, shared Gitea-QEMU scheduler, a synthetic job, or
idle-service readiness. Preserve the exact commit, image digests, guest logs,
and service result proofs without copying credentials into the evidence.
