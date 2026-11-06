# Ordinary local and SSH-selected real-use acceptance

This example extends DIM's existing selected-host scenario. It requires no
managed Project or Native Git/CI policy for ordinary repository sources.

From a DIM source checkout, inspect the command before doing anything else:

```sh
just verify selected-host-smoke --help
just verify selected-host-smoke --config /absolute/private/hosts.json \
  --host local --host disposable-ssh --preflight-only
```

The existing recipe runner exposes the same entry point:

```sh
node scripts/examples/run.ts examples/features/ordinary-workspace verify
DIM_SMOKE_CONFIG=/absolute/private/hosts.json DIM_SMOKE_HOSTS=local,disposable-ssh \
  DIM_SMOKE_PREFLIGHT_ONLY=1 node scripts/examples/run.ts examples/features/ordinary-workspace dev
```

The recipe's fast `verify` stage proves parser, isolation and local HTTP boundary
behavior only. Remove `DIM_SMOKE_PREFLIGHT_ONLY` for the explicit real-use journey;
that is not run by ordinary source CI.

The normal workspace discovery and built-in `dim-environment` skill identify
available owner clients. The smoke uses those same `dim-workspace`, `dim-vm`,
OpenCode and `dim-expose` surfaces, not hidden host sockets or operator tokens.
For the complete schema and exact prerequisites, see
[`tests/scenarios/selected-host/README.md`](../../../tests/scenarios/selected-host/README.md).

An ordinary host profile selects an absolute repository path on that host or a
credential-free HTTPS repository, an exact committed `workspaceSourceSha`, the
expected installed host version, `agent-tools`, `host-llm-router` and
`external-urls`, one existing ingress, and an explicitly selected LLM gateway,
project and route. `native-git` and candidate CI are required only for
`dim://dim-smoke-*` sources. Never use application workspaces as smoke fixtures.

Run the same explicit command without `--preflight-only` only on reviewed
disposable runtime hosts. It creates random `dim-smoke-*` names and validates
UUIDs before cleanup. It exercises binary copy, resource readback,
stop/start/idempotent start/restart, real model/file-tool output, authenticated
OpenCode sessions, a separately served application schema/challenge through
shared ingress, and data/service reconnection after recreation.

To select the heavy VM lane, include the `vm` plugin and a profile field
`"vm": {"image": "FULL_REVIEWED_64_HEX_INCUS_FINGERPRINT"}`. The operator-side
runner provisions one auxiliary VM, grants only the owned smoke workspace,
checks that the agent discovers the exact target, transfers/tests code and
returns an artifact, exercises start/stop, revokes access and discards only the
learned VM UUID. This works without exposing KVM to the ordinary agent container.

The optional top-level `isolatedUpdate` selects five explicit local fixture
inputs: `beforeFacade`, `beforeBundle`, `afterFacade`, `afterBundle`, and immutable
local workspace `image` ID. That lane runs on the disposable host invoking the
scenario, not on its selected production fleet: it creates a fresh private HOME,
config/data/state and install prefix, installs matching reviewed artifacts,
retains one running workspace with a scoped authenticated service during update,
then proves identity, service and authentication continuity before exact cleanup.
Its environment does not inherit DIM selections or Node preloads.

Reports include per-lane `PASS` or `BLOCKED`; command failure is `failed` and
nonzero. Missing VM/update selection yields incomplete acceptance, not a passing
skip. The tool never installs/restarts the fleet, selects a gateway automatically,
copies control-plane secrets into a workspace, or treats OpenCode as the app.
