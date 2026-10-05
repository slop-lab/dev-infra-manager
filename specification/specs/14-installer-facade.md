# Installer Facade

## Scope

`@slop-lab/dim-installer` exposes an executable also named `dim`. It is a thin
facade: it owns the `installer` namespace plus the one explicit obsolete
`install-cp` rejection and proxies everything else to a
separately installed `@slop-lab/dim-cli`. `@slop-lab/dim-cli` must not
implement `installer`, and the facade
must not duplicate `@slop-lab/dim-cli`'s command tree or reimplement its
behavior.

The published executable is a POSIX launcher. When Node.js 24 or 26 is on
`PATH`, it must run the facade with that executable. When no supported Node.js
is on `PATH` but `mise` is available, it must run the facade through `mise
exec node@24` so Node.js need not be present in the global mise configuration.
When neither is available, it must fail with an actionable runtime error. This
bootstrap applies only to the facade; a direct-mode CLI symlink still requires
a supported Node.js on `PATH`.

## Command ownership

The target facade owns:

```bash
dim installer                         # interactive installer (TTY only), always
dim installer install core [--host-mirror-plugin PACKAGE@EXACT_VERSION] [options]
dim installer install control-plane --config FILE
dim installer install plugin PACKAGE@EXACT_VERSION...
dim installer enable-plugin PACKAGE...
dim installer disable-plugin PACKAGE...
dim installer remove-plugin PACKAGE...
```

`dim` with no arguments at all is an alias for `dim installer` only while no
CLI is configured; once one is, bare `dim` instead behaves like any other
command (see Dispatch) and proxies through, matching `dim --help`. This
keeps the ergonomic bare-word default useful for both a brand-new install
and an already-set-up one, without requiring an already-set-up user to type
`dim installer` explicitly just to avoid the wizard.

Repeated leading `installer` namespace tokens are accepted before the
installer command. Every other invocation, including `dim plugin ...`, is
forwarded unchanged. `dim install-cp` is obsolete input, not a forwarded CLI
command or compatibility alias. The facade MUST reject it with exit code `2`,
name `dim installer install control-plane --config FILE`, and make no host
change.

## Dispatch

```text
no args, no CLI          -> interactive installer (TTY); non-TTY prints usage and exits 1
no args, CLI set          -> proxied to the configured executable (empty argv;
                            @slop-lab/dim-cli's own empty-argv behavior mirrors
                            its --help)
--help | -h               -> facade-only help when no CLI is configured;
                            otherwise the configured CLI's own --help, plus a
                            short footer naming the facade commands
--version | -V             -> "DIM installer <version>\nDIM CLI: not installed"
                            when no CLI is configured; otherwise
                            "DIM CLI <cli-version> (via DIM installer <installer-version>)",
                            with a non-fatal warning when the configured
                            version does not match the version the resolved
                            executable actually reports
install-cp                 -> exit 2 with a message pointing at
                              `installer install control-plane --config FILE`;
                              never proxy and make no host change
anything else, no CLI     -> exit 2 with a message pointing at `installer install core`
anything else, CLI set    -> proxied to the configured executable
```

The `install-cp` row is the sole legacy-token exception to the facade's
otherwise namespace-only dispatch. It is matched before configured-CLI proxy
dispatch. The current published facade does not yet implement this exception or
the control-plane command; current behavior is recorded under
[Current availability](#current-availability).

## Configuration

State lives at `$DIM_CONFIG_PATH`, defaulting to
`${XDG_CONFIG_HOME:-~/.config}/dim/config.json`, schema version 1:

```json
{
  "schemaVersion": 1,
  "cli": { "mode": "direct" | "proxied", "version": "0.9.0", "executable": "/abs/path" }
}
```

This file is shared with `@slop-lab/dim-cli` (for plugin discovery); both
readers must preserve unknown fields on write. This is a separate,
package-local config file, not the schema-versioned `DIM_STATE_ROOT` covered
by [Configuration](03-configuration.md).

Before proxying, the facade must verify the configured executable exists and
is executable, and must refuse to proxy to itself (comparing resolved real
paths) to avoid recursive execution. It must never search `PATH` for a `dim`
to fall back to.

## Install modes

Both modes install the DIM runtime—CLI, core, and enabled plugins—into one
private stable directory outside `PATH`:

```text
$XDG_DATA_HOME/dim/runtime/current/node_modules/.bin/dim
```

The installer prepares each replacement in a temporary sibling directory,
verifies its executable, and runs the staged target core package's read-only
state-compatibility preflight before promoting it to `current`. The preflight
uses `DIM_STATE_ROOT`, or the ordinary user-home default when it is unset, and
checks every existing core-owned host, Project, workspace, and CI-runner record
with that target package's parsers. It must use no currently installed CLI or
mutable source checkout, create no lifecycle object, lock, or state directory,
and perform no Docker, Git, or network operation. Plugin-private and otherwise
unknown state families are outside this contract and are ignored.

Known state files and recognized state-family directories must be inspected
without following symbolic links; known records must be regular files. Missing
state is compatible. Malformed or unsupported known state must stop installation
with the family, path, schema failure, and guidance to keep the old pinned DIM
version long enough to export needed data and recreate the resource. The error
must not print state contents. Refusal must leave the current runtime, facade,
user config, plugin activation, image state, and all state bytes unchanged;
temporary package staging is not installed state and must be removed.

The sole compatibility exception is a strict historical host schema-1 record
accepted by the target's existing schema-1 converter. The preflight only warns
that controller startup will perform the already-specified schema-1 to schema-2
migration; installation itself must not migrate it. No workspace, Project,
runner, or other state receives an automatic conversion, deletion, or
delete-and-recreate path.

For a registry installation on a host where the required host mirror plugin is
not already enabled, non-interactive `installer install core` must require
`--host-mirror-plugin @slop-lab/dim-plugin-host-mirrors@<installer-version>` and
reject every other package or version before npm or installed-state mutation.
With a TTY, omission must offer that same exact coordinate as a positive,
default-yes host-operator choice; declining must leave installed state
unchanged. This is installer facade host policy, not a Project, workspace,
capability-provider, or agent prompt. The installer must not select another
provider or silently install an unreviewed plugin.

The selected plugin must join the core and CLI in the same staged npm graph and
be recorded in staged `plugins.json` before promotion. After a successful
preflight, the installer promotes the staged runtime and
invokes the promoted CLI's `controller restart` subcommand exactly once. That
subcommand's controller readiness check is part of the installation
transaction. If restart/readiness or later configuration fails, the installer
must stop a target that already reached readiness before removing its runtime,
then restore the previous `current` directory and restart the prior controller
when one existed. Non-systemd shutdown must be a self-termination request over
the mode-`0600` host-admin Unix socket, followed by a bounded wait for socket
and PID-file cleanup. The controller must stop accepting on all listeners
immediately after flushing the stop response, give active requests a bounded
grace period, close all remaining HTTP connections including incomplete
requests, cancel active command sessions, and bound plugin disposal. If target
shutdown fails, rollback must retain the promoted runtime and prior backup
without restoring one over the other, report the original installation error,
and retain the shutdown error as causal detail. The installer and CLI must not
signal a PID obtained from the filesystem, and the shutdown request must not be
exposed on TCP, workspace, or agent listeners. It must remove
temporary and backup directories after success. DIM
exposes no CLI version-selection or rollback contract.

**Direct** (`--local-bin`) additionally creates or replaces a symlink at
`<prefix>/bin/dim` (prefix defaults to `~/.local`) pointing at that
executable. The facade must only create, replace, or remove a path there if
it is already a symlink resolving inside its own managed runtime
directory; any other existing file or symlink is a conflict that stops
installation without modification. The installer does not infer ownership or
attempt migration from the contents of an unmanaged path.

**Proxied** (`--no-local-bin`) records only the absolute executable path in
config; it must not modify `PATH`.

Detecting an active `mise` environment selects `--no-local-bin` as the
default; every other environment defaults to `--local-bin`. An explicit
`--local-bin`/`--no-local-bin` flag always overrides the detected default.
Before the interactive installer offers direct mode in a detected mise
environment, it must warn that the symlink can shadow the mise shim, bypass
the installer facade, and decouple the invoked CLI from mise's selected
installer version. Interactive yes/no questions must phrase the recommended
mode positively and use `Y` as their displayed default, so repeatedly answering
`y` or pressing Enter preserves the environment-specific recommended mode.

`installer install core --local-packages PATH` must accept a schema-1 `packages.json`
bundle produced by the repository package script. It installs every tarball
except `@slop-lab/dim-installer` in one npm transaction and records the version
reported by the installed CLI. The normal direct/proxied selection still
applies; manifest versions do not select filesystem paths. The local-bundle-only
`--defer-controller-restart` option suppresses the core promotion restart so a
reviewed source installer can activate required plugins first. Other install
sources must reject that option. The source installer must perform exactly one
explicit controller restart after plugin activation before reporting success.

Plugins install into a temporary sibling copy of the same `runtime/current`
npm project and replace `current` only after npm and activation-manifest
validation succeed. Plugin packages
must declare the exact compatible `@slop-lab/dim-core` as a peer dependency so
npm rejects an incompatible host before activation. CLI replacement reinstalls
the enabled plugin set in staging and must succeed as one dependency graph
before promotion. `plugins.json` lives in `runtime/current`; no independent
plugin installation root or persisted `pluginHome` setting exists.
Local plugin tarballs are copied into `runtime/sources` before installation;
the runtime must not depend on the caller's source path remaining available.
Disabling a plugin removes it only from `plugins.json`; enabling requires an
installed direct dependency, and removal deletes both dependency and manifest
entry and prunes unreferenced managed tarballs.

## Proxy contract

When forwarding a command to the configured `@slop-lab/dim-cli`, the facade
must preserve argv (including everything after `--`), the current working
directory, stdio and TTY, the exit code, and process signals, and must add
exactly two environment variables:

```text
DIM_INVOKED_VIA_INSTALLER=1
DIM_INSTALLER_VERSION=<installer version>
```

`@slop-lab/dim-cli` may use these two variables only to adjust `--help`
display text (root help and a short per-subcommand footer). They must not
affect command dispatch, configuration resolution, credential handling,
JSON output, lifecycle behavior, or exit codes, and must produce
byte-identical output to unset when unset.

## Plugin installation

`dim installer install plugin` requires an installed CLI because plugins join its npm
project and npm must validate their core peer dependency against that runtime.
`installer enable-plugin`, `installer disable-plugin`, and `installer remove-plugin` provide recovery without
hand-editing the managed npm project or activation manifest.

## Verification

Required tests cover:

- facade-only vs. proxied `--help`/`--version` in both installed states,
  including the version-mismatch warning;
- bare `dim` opens the interactive installer only when no CLI is
  configured, and proxies through like any other command once one is;
- installation and plugin-lifecycle argument parsing, including conflicting
  `--local-bin`/`--no-local-bin`, exact required-host-plugin selection, TTY
  acceptance and refusal, non-TTY fail-closed behavior, and local package bundle
  validation;
- managed-symlink create, idempotent replace, and rejection of an
  unmanaged/foreign path at the same location;
- successful CLI replacement prunes old managed installation directories;
- unsupported and malformed known state refuse installation before runtime,
  config, facade, plugin, or symlink promotion and remain byte-identical;
- missing state and exact current schemas pass, while exact historical host
  schema 1 passes read-only with a controller-startup migration warning;
- local-package installation resolves the preflight from the staged bundle's
  core metadata and code rather than the old installed CLI;
- proxy argv/cwd/env/stdio/exit-code fidelity;
- stale config (missing executable, facade self-reference) surfaced as
  actionable errors, not silent fallback to a `PATH`-resolved `dim`;
- `dim plugin ...` never intercepted by the facade;
- local tarball sources survive deletion and CLI replacement, plugin
  enable/disable/remove changes both activation and installation state, and a
  peer dependency failure leaves the existing runtime usable;
- `mise use --raw --global 'npm:@slop-lab/dim-installer@<version>'` end to end against a
  disposable local npm registry (`just verify mise-install-smoke`), covering
  non-TTY refusal before mutation, same-version host-mirror activation before
  first readiness, the mise-detected `--no-local-bin` default, and an explicit
  `--local-bin` override.

## Control-plane bundle

This section is a target contract and is not implemented by the current
installer release.

**INSTALLER-CONTROL-PLANE-001:** The facade exclusively owns:

```bash
dim installer install control-plane --config FILE
```

The command installs or updates one Docker Compose v2 project named
`dim-control-plane`. It contains exactly two long-running services:
`native-git`, which owns native Git transport, review evidence, and the durable
review-event outbox, and `ordinary-ci`, which owns ordinary CI admission,
webhook inbox, demand, queueing, claim receipts, leases, and report retry. It
MUST NOT install Gitea, a browser UI, a reverse proxy, a runner
daemon, or a Project-specific service or image. `@slop-lab/dim-cli` MUST NOT
implement, proxy, or alias this operation.

The installer config is a regular, non-symbolic-link, DIM-user-owned mode-`0600`
JSON file with this exact schema. All paths are absolute. Unknown or missing
keys are errors.

```json
{
  "schemaVersion": 1,
  "deploymentId": "main",
  "nativeGit": {
    "image": "registry.example/dim/native-git@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "configFile": "/etc/dim-control-plane/native-git.json",
    "readinessTokenFile": "/etc/dim-control-plane/native-git-readiness.token",
    "publish": { "host": "127.0.0.1", "port": 7443 }
  },
  "ordinaryCi": {
    "image": "registry.example/dim/ordinary-ci@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "configFile": "/etc/dim-control-plane/ordinary-ci.json",
    "readinessTokenFile": "/etc/dim-control-plane/ordinary-ci-readiness.token",
    "publish": { "host": "127.0.0.1", "port": 7410 }
  }
}
```

`deploymentId` is a safe lower-case identifier and is durable identity, not a
Compose project-name selector. Both images MUST be registry references pinned
by a complete `sha256` digest, without a tag. Both service config and readiness
token source files MUST be regular, non-symbolic-link, DIM-user-owned mode-`0600`
files. A readiness-token source contains
exactly one base64url token of at least 32 random bytes followed by one newline,
and MUST differ from every service, registrar, host, webhook, Git, reviewer,
scheduler, and CI-result credential. Mutable operator source paths are installer
input only and MUST NOT be mounted into a service. Secret bytes MUST NOT enter a
data volume, Compose environment, image, log, or generated Compose file.

The bundle has these fixed runtime properties:

| Property | `native-git` | `ordinary-ci` |
| --- | --- | --- |
| Numeric user/group | `10001:10001` | `10002:10002` |
| Container listener | `0.0.0.0:8080` | `0.0.0.0:8080` |
| Published listener | exact configured `publish.host:publish.port` | exact configured `publish.host:publish.port` |
| Config mount | generation snapshot at `/run/secrets/service.json`, read-only | generation snapshot at `/run/secrets/service.json`, read-only |
| Readiness token | generation snapshot at `/run/secrets/readiness.token`, read-only | generation snapshot at `/run/secrets/readiness.token`, read-only |
| Activation token | generated snapshot at `/run/secrets/activation.token`, read-only | generated snapshot at `/run/secrets/activation.token`, read-only |
| Persistent volume | `dim-control-plane-native-git-data` at `/var/lib/dim-native-git` | `dim-control-plane-ordinary-ci-data` at `/var/lib/dim-ordinary-ci` |

The fixed bridge network is `dim-control-plane`. Only these two services attach
to it. Each volume is service-private: the other service MUST NOT mount it, and
no host path, Project, workspace, worker, or additional container may share it.
The native Git service stores bare repositories and review/CI evidence only in
its volume. The ordinary CI service stores its versioned SQLite database and
WAL files only in its volume. The installer MUST create a new empty volume only
when it is absent; an absent volume after a prior successful installation is a
fatal data-loss condition, not permission to recreate it.

Every bundle resource carries `org.dim.managed=true`,
`org.dim.bundle=control-plane`, `org.dim.deployment=<deploymentId>`, and
`org.dim.resource=network|volume|service`. A service container or volume also
carries `org.dim.service=native-git|ordinary-ci`; the network MUST omit that
label. Inspection requires this complete exact set in addition to Compose's
own labels. A partial, malformed, foreign, or mismatched set is a conflict and
MUST NOT be adopted, relabelled, started, stopped, or removed.

Installed deployment state lives in the DIM-user-owned mode-`0700` directory
`${XDG_STATE_HOME:-~/.local/state}/dim/control-plane`. Before image or Compose
mutation, the installer copies all four private operator source files without
following links into a newly created
`generations/<64-lowercase-hex-generation-id>` mode-`0700` directory. It opens
each source once, verifies the already-open descriptor's owner, mode, regular
file identity, and stable bytes, then writes an fsync-published snapshot. Config
and readiness snapshots are mode `0444` so the fixed nonroot service identity
can read the individually mounted file; the mode-`0700` generation directory
prevents host users from traversing to them. The generated Compose file mounts
only those exact snapshot paths. The installer also generates distinct native
and ordinary activation tokens of at least 32 random bytes, stores each as a
mode-`0444` snapshot mounted only into its service, and retains the installer-
readable bytes for activation and rollback. Activation tokens are not operator
input and differ from every other credential. The installer never rewrites a
published generation.

`compose.yml` contains the exact last successful rendered Compose bytes and is
mode `0600`. `install.json` is mode `0600` with this exact schema:

```json
{
  "schemaVersion": 1,
  "deploymentId": "main",
  "generationId": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
  "composeSha256": "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  "nativeGitImage": "registry.example/dim/native-git@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "ordinaryCiImage": "registry.example/dim/ordinary-ci@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "nativeGitConfigSha256": "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  "nativeGitReadinessTokenSha256": "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
  "ordinaryCiConfigSha256": "sha256:1111111111111111111111111111111111111111111111111111111111111111",
  "ordinaryCiReadinessTokenSha256": "sha256:2222222222222222222222222222222222222222222222222222222222222222",
  "nativeGitActivationTokenSha256": "sha256:3333333333333333333333333333333333333333333333333333333333333333",
  "ordinaryCiActivationTokenSha256": "sha256:4444444444444444444444444444444444444444444444444444444444444444",
  "volumesEstablished": true
}
```

The generation ID is the SHA-256 digest of a domain separator plus the
length-framed image references, four exact operator-input snapshot byte
strings, and two generated activation-token byte strings. The six recorded
digests permit independent verification without recording a secret.
The Compose digest covers the exact `compose.yml` bytes. `volumesEstablished` is
published only after both exact labelled volumes have been created or
inspected and is thereafter always `true`; a true record with either volume
absent is the fatal data-loss condition above. The installer accepts no
schema-less, extra-field, symbolic-link, wrong-owner, wrong-mode, digest-
mismatched, or temporary installed-state artifact. It holds one exclusive
owner-recorded lock in this directory across inspection, update, readiness,
publication, and rollback. A concurrent invocation fails before Docker
mutation rather than sharing the transaction.

The current generation and its immediate predecessor are retained until a
later successful transaction makes the predecessor unnecessary. A failed
transaction retains its candidate snapshot and the prior snapshot as recovery
evidence. Garbage collection may remove only a non-current, non-predecessor
generation after validating its ID, every recorded digest, and that no
installed or recovery Compose file references it.

Both services run with `read_only: true`, `no-new-privileges:true`, all Linux
capabilities dropped, no privileged mode, no device, no host namespace, and
only a service-private `tmpfs` at `/tmp` with `nosuid,nodev,noexec`. Neither
service receives a Docker, containerd, controller, workspace, hypervisor, or
host-admin socket. The Compose bundle therefore cannot execute jobs. Every
ordinary job is executed by an independently authenticated DIM host controller
using that host's already configured runtime and capacity; the scheduler may
grant or fence a lease but may not address a host runtime directly.

The configured published addresses are the only host ports. Duplicate ports,
wildcard hosts (`0.0.0.0`, `::`, or empty), multicast, and non-local addresses
are rejected unless the address is assigned to a local interface. TLS and any
public reverse proxy are operator-owned prerequisites outside this bundle. An
operator exposing either listener beyond loopback MUST configure authenticated
TLS before using it; the installer does not create certificates or report a
plain-HTTP endpoint as production-ready.

## Admission and native-CI dependency

**INSTALLER-CONTROL-PLANE-ADMISSION-001:** Bundle readiness is not Project
admission. Installing the bundle creates no Project, repository, runner,
capacity, workflow, webhook, or job image. This installer contract does not
select native Git for core Project lifecycle. Until a separate native
Project/repository state adapter contract is approved and implemented, every
native Project or repository admission request and every controller attempt to
advertise ordinary capacity MUST fail before service-state or runtime mutation.
The installed services therefore remain an idle, empty control-plane bundle.

The later adapter MUST separate operator Project admission from candidate job
selection. Admission binds one native Git Project/repository, protected ref,
policy and required-review/required-job-set revisions, required job names and
their `candidate-controlled` evidence class, the ordinary service's global
operator capacity-config digest, and admission generation. It carries no
per-Project capacity list. The exact candidate commit/tree then selects schema-2
`.dim/ci/runner.yml`, script blob, normalized fixed argv, and digest-pinned
disposable image under `CI-NATIVE-CANDIDATE-JOB-001`. Those candidate bytes are
unreviewed execution input, not admission authority or independent
verification. The adapter must not create a persistent per-Project runner,
worker container, image copy, or capacity record. These tuple fields constrain
the service interfaces but do not authorize admission before that adapter
exists.

Native Git MUST fail closed for a protected ref that requires CI unless the
ordinary service reports the exact current admission and current
scheduler-issued attempts for every required job. Missing, unreachable,
expired, revoked, stale, foreign, or tuple-mismatched ordinary admission makes
the native service not ready for promotion and leaves the protected ref
unchanged. It MUST NOT reinterpret service process health, a webhook delivery,
available host capacity, an earlier successful attempt, or a Project-scoped
runner record as CI evidence. Repository read and proposal-only write transport
may remain available during an ordinary scheduler outage; protected promotion
may not.

For a candidate-controlled required job, native Git MUST also require the
current terminal record to match the exact execution-descriptor digest issued
for that attempt. The reviewer and promotion DTOs MUST label it
`candidate-controlled` and expose the candidate config, script, image, and argv
provenance. A successful exit MAY satisfy that explicitly configured required
condition, but MUST NOT be described as an independent check, proof that its
tests are correct or complete, or blanket product correctness. Product
maintainers still review changed requirements, implementation, test definitions,
and relevant results. Infrastructure security review separately follows secret
exposure and trusted capability changes. Current complete-tree human approval
and the final checked compare-and-swap remain mandatory.

The optional shared QEMU scheduler is a predecessor Gitea-only service and
configuration. It is never added to this Compose project, cannot be configured
with native selection, is not an ordinary-job fallback, and does not satisfy
the native ordinary-CI prerequisite. Absence of QEMU capacity is reported as
unavailable, never as successful ordinary CI.

## Validation, update, readiness, and rollback

**INSTALLER-CONTROL-PLANE-TRANSACTION-001:** Before persistent control-plane
resource mutation, the facade MUST validate the install config, ownership and
mode of all four private files, digest syntax, local non-conflicting published
addresses, Compose v2 availability, and the absence or exact ownership of the
project, network, containers, and volumes. It then pulls both digest references,
verifies the resolved digests, and runs each image's `/usr/local/bin/dim-service
check-config /run/secrets/service.json` in a read-only, network-disabled,
socket-free one-shot container with the same user and config mount that service
will receive, but no data volume. `check-config` parses and cross-checks config
only and performs no state I/O. Validation failure makes no Compose, network,
volume, config, or service mutation. A pulled digest may remain in the Docker
image cache and MUST be reported; image-cache presence is not installed bundle
state.

The installer then runs the native image's `/usr/local/bin/dim-service
check-bundle-config /run/native.json /run/ordinary.json` in the same restricted
one-shot shape with both config snapshots mounted read-only. It requires exact
reciprocal service IDs, fixed Compose-network endpoints, byte-identical paired
webhook/query/identity/attempt-issuer/result-reporter credentials, and global
credential distinctness. Until the native Project adapter exists, it also
requires an empty native repository registry, no Project-scoped native
identity, and no ordinary Project admission in config. This command performs
no network or state I/O. Any mismatch is a pre-mutation refusal.

Before allocating activation tokens or a generation, the installer compares
the descriptor-verified image references and four operator-input byte digests
with the valid installed record. If they are identical, it verifies the
recorded generation, Compose bytes, complete resource ownership, running image
digests, and both authenticated readiness responses and returns success without
rendering, replacing, activating, or creating anything. Any mismatch proceeds
as an update; missing or inconsistent installed resources are errors rather
than reasons to regenerate an otherwise identical deployment.

For an update, each candidate image MUST also expose
`/usr/local/bin/dim-service compatibility --json`. The installer runs it for
both candidate and prior services before container replacement and requires
exact JSON shaped as `{"schemaVersion":1,"writeFormat":3,"readableFormats":[3]}`.
`writeFormat` is one positive integer; `readableFormats` is a non-empty sorted
array of unique positive integers. The installer also runs both candidate and
prior images' `dim-service check-state --read-only /var/lib/dim-native-git
--json` for native Git and `dim-service check-state --read-only
/var/lib/dim-ordinary-ci --json` for ordinary CI, with only that service's data
volume mounted read-only. Each returns exact JSON
`{"schemaVersion":1,"stateFormat":3}` and performs no write. The candidate and
prior probes must report the same state format. The update is admitted only
when that current state format is in both images'
`readableFormats`, the candidate write format is in the prior image's
`readableFormats`, and the prior write format is in the candidate image's
`readableFormats`. Missing, malformed, asymmetric, or non-overlapping metadata
is a pre-mutation failure. First installation requires empty volumes and does
not infer compatibility from absent metadata. These are format admission, not
data migration; all compatibility probes are network-disabled and read-only.

The installer renders Compose bytes into an owner-only temporary directory,
runs `docker compose config --quiet`, and records the exact prior rendered
Compose bytes and image digests before replacement. The only supported order is:

1. create or inspect the network and both volumes without adopting foreign or
   partially labelled resources;
2. replace `ordinary-ci` in standby mode and wait for its authenticated
   `GET /readyz` to return `200` and exact JSON
   `{"status":"ready","schemaVersion":1}` based only on its parsed immutable
   snapshot, local database readability/durability, and local listener state;
3. replace `native-git`, wait for the same response shape from its `/readyz`;
4. require native Git readiness to include a successful authenticated
   dependency probe to the installed ordinary service identity; and
5. atomically publish the new rendered Compose bytes, install record, and
   generation ID as installed state, then activate that exact generation.

Ordinary readiness MUST NOT contact native Git, require a Project, or validate
admission/webhook state. Ordinary CI instead verifies the configured native
identity, repository tuple, and credential role on each later admission,
webhook, attempt, and result operation. Native readiness may depend on ordinary
identity and read-only current-attempt queries. Before exact-generation
activation, both candidate services return `503` for every state-mutating
endpoint and create no admission, webhook, attempt, claim, result, repository,
review, or promotion state. Activation accepts only the installer-held
generation credential over the private Compose network and is idempotent for
the published generation; a service rejects any other or unpublished
generation.

Each readiness request uses `Authorization: Bearer <readiness token>`, follows
no redirect, has a two-second connect/request timeout, and is retried for at
most 60 seconds. `/healthz`, container running state, an open TCP port, and
Compose exit success are not readiness. Readiness responses MUST disclose no
credential, Project, repository, job, path, or host inventory.

On any failure after mutation, the installer stops and removes only replacement
containers whose complete bundle/deployment/service labels match, restores the
prior rendered Compose bytes, exact prior image digests, prior generation ID,
and all four prior input snapshots, starts `ordinary-ci` before `native-git`,
and repeats both authenticated readiness checks before reactivating that exact
prior generation. Operator source files are never rewritten. Data volumes are
never rolled back, deleted, copied, or replaced; prior-image readability of
candidate writes is the mandatory precondition that makes service rollback
valid. A failed first installation removes exact owned
containers and network but retains any created volume and reports it for
operator inspection. If replacement shutdown or prior-version readiness
fails, the installer stops automatic rollback, retains both rendered Compose
files, both generations' input snapshots, and all volumes, and reports the
original and rollback errors. It MUST NOT report success, delete recovery
evidence, select another image, or start a second bundle.

Changing `deploymentId`, either numeric identity, fixed container port, fixed
mount path, fixed volume name, or Compose project name in place is unsupported.
An existing schema-less or non-schema-1 installer record, legacy ordinary-pool
schema-2 database, Project-scoped Sysbox runner state, `dim install-cp`
invocation, or separately launched `dim ci ordinary-pool service|worker`
process MUST be rejected before mutation. There is no compatibility alias,
implicit migration, dual-service period, volume adoption, or automatic cleanup.
Operators must use the old pinned release to stop legacy services and perform
an explicitly reviewed fresh installation; this contract defines no backup,
export, or data-conversion authority.

Required acceptance evidence is specified by
[Verification](12-verification.md#control-plane-bundle-gate).

## Current availability

The current published implementation has neither `dim installer install
control-plane` nor the facade's legacy-token interception. Its CLI-owned `dim
install-cp` placeholder fails closed without host changes. The target facade
command, bundle, snapshots, service credentials, host-controller supervision,
and native Project adapter MUST NOT be presented as shipped until their
implementation and the complete control-plane bundle gate pass.
