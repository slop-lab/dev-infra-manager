# @slop-lab/dim-core

`@slop-lab/dim-core` implements DIM's native Project, workspace, host, and CI
boundaries. Most users should install `@slop-lab/dim-cli`; this package is for
the CLI, trusted services, plugins, and contributors.

## Scope

The package provides:

- native root bootstrap, import proof, readiness, review, and checked
  protected-ref promotion primitives;
- strict schema-6 root-only Project and schema-9 native workspace state;
- persistent Sysbox workspace create, setup, start, stop, restart, update,
  resource, and discard operations;
- workspace-scoped proposal Git authority and short-lived read/write leases;
- installed native Git and ordinary-CI service contracts;
- global bounded ordinary Sysbox host execution;
- global native QEMU scheduler, trusted runner image, KVM host execution, and
  terminal evidence contracts;
- host lifecycle, diagnostics, plugin loading, and image-build helpers.

DIM core does not manage Gitea, repository catalogs, Project deletion,
Project-scoped runners, an ordinary pool, or a shared predecessor QEMU
scheduler. Historical state for those products is rejection/export-only.

## Installation

Pin exactly the version used by the CLI:

```bash
npm install --save-exact '@slop-lab/dim-core@0.10.0'
```

The package is ESM-only, supports Node.js 24 and 26, and runs on Linux. Runtime
lifecycle operations require Git, Docker, procfs, and util-linux `flock`.
Workspaces require `sysbox-runc`; native QEMU execution additionally requires
real accessible KVM.

## Native lifecycle

Native lifecycle selection uses the absolute, owner-only mode-`0600` file named
by `DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE`. Project publication also uses a
distinct importer connection selected by
`DIM_NATIVE_ROOT_IMPORTER_CONNECTION_FILE`. Role credentials are distinct and
never enter Project code, workspace containers, candidate jobs, logs, command
arguments, or persisted workspace state.

Root bootstrap accepts only an already-local reviewed repository and one full
branch ref. It retains an immutable bundle and policy before service mutation,
then proves the imported commit, tree, policy, and generation. Project
readiness separately revalidates live service identity and materializes the
protected root before publishing strict schema-6 state.

Workspace creation accepts only a ready native Project. It stores strict
schema-9 state with a fixed `root` repository snapshot and proposal-only writer
authority. Recommended workspaces use Sysbox and persistent home, checkout,
and private Docker volumes. Reviewed `.dim/setup.sh`, `.dim/entrypoint.sh`,
`.dim/teardown.sh`, or `.dim/docker-compose.yml` selects a custom environment.

## CI boundaries

The installed bundle starts empty and idle. Native review events create
candidate-controlled eligibility; they do not advertise host capacity or
approve promotion. The ordinary host consumes fixed digest-pinned images and
bounds from an operator file, requires `sysbox-runc` and one exact host mirror
provider, and reconciles the DIM-owned pull-through cache and control network
before it locks capacity.
The trusted ordinary runner uses `/bin/sh`, Docker's daemon entrypoint, the
Docker client, and `timeout`; it does not require Bash in the runner image.
Candidate job images still require `/bin/bash` and execute only the fixed
`/bin/bash --noprofile --norc /run/dim/job/script` command.

Native QEMU is separately deployed. The scheduler and trusted runner images
are explicit build artifacts. A host verifies `/dev/kvm`, the trusted launcher,
Docker image-mount support, and the pinned job image before attestation or
claim. The guest receives only verified candidate bytes and bounded writable
workspace state. It receives no scheduler, native Git, reviewer, promotion,
Docker-host, or DIM host credential. There is no TCG or ordinary fallback.
The QEMU supervisor runs with the host worker's UID/GID, only the KVM device
group, no capabilities, and no privilege regain. Writable 9p workspace metadata
uses `mapped-xattr`, so guest ownership and permission changes do not alter host
ownership or prevent normal-user cleanup. The workspace filesystem must support
user extended attributes. Ordinary hosts keep polling while accepted results
await the central reporter's acknowledgement; capacity remains fenced until then.

Candidate-selected ordinary or QEMU success is evidence, not approval.
Protected promotion requires the exact immutable review, required human
approvals, current policy/job revisions, both required evidence classes, and a
checked compare-and-swap from the expected protected head.

## Configuration and state

The relevant host boundaries include:

- `DIM_STATE_ROOT`
- `DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE`
- `DIM_NATIVE_ROOT_IMPORTER_CONNECTION_FILE`
- installed workspace backend and `DIM_WORKSPACE_IMAGE`
- `DIM_WORKSPACE_CPUS`, `DIM_WORKSPACE_MEMORY`, and `DIM_WORKSPACE_PIDS`

Project schema 6 and workspace schema 9 are current and strict. Provider-backed
Project records, old workspace schemas, repository catalogs, runner records,
and obsolete selectors are rejected unchanged with export/recreation guidance.
Core never adopts, migrates, deletes, or renames predecessor resources.

Package imports do not start daemons or mutate host state. Consumers must call
explicit lifecycle/service entrypoints, surface typed errors, and preserve
cleanup uncertainty rather than reporting success.

See the normative [configuration](../../../specification/specs/03-configuration.md),
[lifecycle](../../../specification/specs/13-repo-workspace-lifecycle.md), and
[verification](../../../specification/specs/12-verification.md) contracts.
