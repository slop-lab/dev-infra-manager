---
name: dim-environment
description: Discover the current DIM workspace, host-provided integrations, services, resources, and explicitly authorized capabilities before relying on environment-specific behavior.
---

# DIM environment

Run `dim-workspace discovery` for the authoritative current JSON. The materialized
`~/.config/dim/discovery.json` is a readiness snapshot and is refreshed by the
host; prefer the command before making environment-dependent decisions.
Use `executionEnvironment` to distinguish this existing workspace runtime from
the selected host, `pluginSet` for
installed host owners, `serviceEndpoints` for guest-reachable or merely declared
routes, and `developerCapabilities` for the currently available capability
summary. The complete `capabilities` list retains blocked and unavailable facts.
`delivery: online` is a live authenticated observation. `delivery:
readiness-cache` is the last host readiness snapshot; compare its timestamps and
fingerprints before relying on it.
Check `observedAt`, `executionEnvironment.runtimeStatus`, and `freshness` before
using the snapshot. `isolation.kind: unknown` means the runtime owner did not
declare a posture; do not guess one. Service endpoint authorization is scoped to
this immutable workspace UUID and never carries credentials. The skill's
`agent.guidance` metadata identifies its host-core provenance and readiness-time
refresh behavior.
If the command cannot reach the workspace bridge, report the bridge as
unreachable. Do not reinterpret that transport failure as an unconfigured or
unsupported capability; those states appear only in a successful discovery.

Use only capabilities whose `state` is `available`. Access kinds mean:

- `workspace-local`: use the capability directly inside this workspace.
- `guest-operation`: invoke only the named operation with
  `dim-workspace plugin OWNER OPERATION [JSON]`; do not invent host commands,
  workspace selectors, or payload fields.
- `external`: the capability exists outside the guest; do not claim a guest route.
- `none`: no callable route is available.

Treat `blocked` and `unavailable` as real states. Never infer credentials,
operator authority, devices, or services that discovery does not report.

## KVM

Read the `kvm` owner's `direct-access` and `vm-fd-verification` capability facts.
An absent guest `/dev/kvm` is not enough to infer the selected machine's support;
use those facts. `blocked` with `runtime-grant-required` means an operator must
create a separate `container-kvm` workspace. Do not attempt to grant the current
workspace access. When `vm-fd-verification` is available, its fixed `verify`
operation proves only KVM API access and creation of a VM file descriptor. It
does not boot a VM or authorize repository suites, host commands, or arbitrary
KVM operations.

The separate `vm` owner's `auxiliary-vm-access` capability may be available in
an ordinary workspace with no `/dev/kvm`. When advertised, use `dim-vm list` to
learn the exact granted targets/permissions, then `dim-vm status`, `exec`, `push`
and `pull` for that target. VM creation and grants belong to the host operator;
do not request host sockets, operator credentials or another workspace's token.

## Application services and recovery

Declared plugin endpoints with `readiness: not-probed` are not proof of a working
service. Use the owner's advertised client/operation, check its actual response
and report the specific missing connection or grant. A workspace preparation
failure does not imply its runtime stopped: check discovery and `dim show` through
the operator, retaining existing sessions and data while the owner repairs it.

OpenCode is a coding-agent server, not your application's API. Discover an
application's documented port, authentication and response schema from its own
repository. If `external-urls` advertises `dim-expose`, publish only that known
port and verify the returned URL from the consumer side. Route declaration or an
OpenCode health response does not prove that an application is provisioned.

For disposable DIM acceptance from a DIM source checkout, see
`examples/features/ordinary-workspace/README.md` and
`just verify selected-host-smoke --help`. Host selection, LLM project scope,
reviewed VM images and isolated-update bundles must be supplied explicitly by
the operator; absence is a blocked lane, never permission to discover credentials.
