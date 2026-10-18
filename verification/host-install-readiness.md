# Host installation and real-use readiness

Verify one exact source candidate. Source checks, disposable runtime checks,
real SSH transport and optional service/CI checks establish different facts.
Keep run logs outside tracked documentation and report unavailable hardware or
uncertain cleanup as such. Earlier candidate results do not verify a changed
installation.

## Base remote development

The base path needs a Linux Docker host with registered `sysbox-runc` and
working cgroup resource enforcement, plus a supported Node.js 24/26 runtime.
It needs no controller, native Git, mirror plugin, CI worker or KVM device.
For a fresh Ubuntu VM, use the reviewed [role bootstrap](bootstrap-ubuntu-vm.md),
including its rootlesskit AppArmor setup and new-login handling.

Build and install the exact source candidate without publishing packages:

```bash
just prepare-local
just install-local
dim image build
dim create https://example.com/team/app.git dev
dim exec dev -- sh
dim resources dev --cpus 4 --memory 8g --pids 4096
dim stop dev
dim start dev
dim recreate dev
dim discard dev --yes
```

Create a disposable repository containing a committed file. Verify that local
edits, home files and a nested Docker image survive stop/start and recreate.
Inspect the runtime: one unprivileged Sysbox container, three UUID-owned
volumes and its private bridge; no host bind or Docker/control socket. Verify
resource readback and discard cleanup using only owned fixture resources.

`just verify workspace-runtime` runs the production source/runtime adapter
against a locally built image, including nested Docker, retained storage,
resource updates and missing-volume rejection. The real SSH fixture is
`verification/scripts/base-workspace-ssh-smoke.mjs`; its setup/run/cleanup
phases use a disposable trusted SSH host with a loopback-only published port,
a temporary key and client configuration. Only that trusted admin host
receives the Docker socket. The development workspace does not.

For an operator-owned remote host, configure `dim host add NAME --ssh SSH_TARGET`,
select it with `dim host use NAME`, then run the same root commands. Git source
paths refer to the selected host. Verify stdin, stdout, stderr and nonzero exit
codes, and verify that the workspace resources exist on the selected host.
See the [CLI reference](../core/packages/cli/README.md) for forwarding and host
configuration.

## Optional managed Git and review

Install the optional library deliberately:

```bash
just install-local --with-managed
# Published matched artifacts use:
# dim installer install core --with-managed
```

This does not install plugins or start a controller. Prepare service
configuration with reviewed digest-pinned native Git and ordinary CI images:

```bash
dim managed control-plane prepare /absolute/private/operator \
  --native-git-image registry.example/native@sha256:EXACT_DIGEST \
  --ordinary-ci-image registry.example/ci@sha256:EXACT_DIGEST
```

Review the generated private files, then follow the printed facade install and
connect commands. Connect attests the live service generation and writes role
connections for the host, registrar, importer, reviewer and promoter. Keep
these files outside workspaces and logs. Bootstrap a reviewed root repository,
admit it, prove readiness, and create `dim create dim://PROJECT dev` on the
selected host. Use the generated reviewer connection to initialize the
optional review web UI; do not copy private service JSON into an agent.

`just verify native-basic-lifecycle` builds matched optional packages and
a disposable slim workspace image. It exercises real Git bootstrap,
admission/readiness, proposal push, protected/foreign write denial, human
approval and checked promotion, then continued Git access in the same
workspace and shared stop/start/recreate/discard. It does not establish
independent CI or multi-host acceptance.

Optional plugin authority can be checked with `just verify
controller-workspace-relay-smoke IMAGE` against a matched build. This uses the
current core workspace and bounded relay rather than an obsolete privileged
outer workspace or automatically trusted repository hook.

## Source and optional execution checks

Use `just check-source` for the pinned disposable source environment and
`DIM_SOURCE_NODE_MAJOR=26 bash verification/scripts/source-gate-container.bash`
for the alternate Node major. The source container does not receive the host
Docker socket. Use `just typecheck` for compiler feedback without physical
runtime claims.

Installed control-plane image checks, ordinary Sysbox CI execution and real
QEMU/KVM execution are separate optional checks. Use their current recipes in
[verify.just](verify.just), review their explicit image/device prerequisites,
and retain each actual outcome. A source-only or same-host result does not
prove independent worker isolation, host reboot recovery or multi-host
operations. Previous schema-9/two-runtime cutover and competing CI matrix
scripts were retired; their historical acceptance markers are not current
evidence.

Before treating a candidate as ready, inspect actual cleanup, protected-ref
state, secret-bearing configuration permissions and the final command exit
status. Do not declare success from an intermediate log line when the outer
verification failed.
