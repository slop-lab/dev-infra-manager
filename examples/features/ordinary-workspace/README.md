# Ordinary local and SSH-selected real-use acceptance

## T3 Code browser verification

Use a disposable installed host and DIM Web with the agent-tools host and Web
plugins enabled. Start T3 Code in the selected workspace and create a root HTTPS
route for port `3773` using the External URLs example. Use its permalink when
one is issued. The browser must trust the ingress certificate. Configure OMP
and its scoped LLM router in the workspace before enabling the optional OMP step.

Set `DIM_CHROMIUM` to the reviewed Chromium executable and
`DIM_T3_EXAMPLE_PROFILE` to an absolute, mode-0600 JSON file. The file has `web`,
`username`, `password`, and `workspaces` fields. Each workspace has `host`,
`name`, `t3Origin`, and `project` fields. Set `omp` to `true` for a workspace
whose T3 default provider is the local OMP ACP command. Each listed workspace
must have its own T3 HTTPS origin. Run `just verify t3-workspace` for just this
browser journey, or set the same profile with the ordinary `verify-vm` recipe
to run it after the selected-host checks.

The browser signs in to DIM, selects the exact workspace, verifies an anonymous
client cannot pair through DIM, clicks **Open T3 Code**, and checks that T3
accepts the grant once and issues a Secure, HttpOnly cookie. Reopening from DIM
uses the existing T3 session. The optional OMP step sends a prompt
through the workspace provider and checks its rendered result.

## Selected-host checks

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

The recipe also declares `verify-vm`, so the existing installed examples runner
actually invokes this smoke instead of omitting it. That stage rejects
`DIM_SMOKE_PREFLIGHT_ONLY=1`: provisioning or preflight alone is not VM acceptance.
The separate-VM harness still owns separate control-plane and workspace-host VMs;
this recipe neither replaces them with containers nor implicitly selects a host.

### Prepare from reviewed artifacts and small host bindings

Instead of hand-authoring source hashes, versions, plugin lists, workspace names
and SSH keys in a full profile, supply `DIM_SMOKE_BINDINGS` and
`DIM_EXAMPLE_PACKAGE_BUNDLE`. The latter is the existing source-build bundle
containing `packages.json` and `.dim-source-state`. For example:

```json
{
  "schemaVersion": 1,
  "hosts": [{
    "name": "disposable-host",
    "source": "/srv/reviewed/dim-source",
    "ingress": "shared",
    "llm": {"configFile": "/private/host/gateway.json", "project": "smoke", "route": "default", "provider": "dim-responses", "model": "REVIEWED_MODEL_ID", "operatorConnectionFile": "/private/host/read-only.json"},
    "vm": {"image": "REVIEWED_64_HEX_INCUS_FINGERPRINT"}
  }]
}
```

The repository on each selected host must contain the bundle's source commit;
an ordinary seed at another commit can explicitly set `workspaceSourceSha`.
Only explicit names in this file are selected. Gateway config paths refer to
files already on their selected host, not files copied into an agent container.
The generator validates the same full profile contract, creates a fresh test
SSH key and owner-only profile in a temporary directory, then removes those
local inputs when the existing smoke exits. It does not provision provider
authentication, approve ingress or configure Incus.

```sh
DIM_SMOKE_BINDINGS=/absolute/private/bindings.json \
DIM_EXAMPLE_PACKAGE_BUNDLE=/absolute/reviewed/packages \
  node scripts/examples/run.ts examples/features/ordinary-workspace verify-vm
```

The stock separate-VM gate requires these real bindings to be provisioned for
its installed host before the recipe can pass. Missing bindings are an explicit
failed prerequisite, not a skipped recipe or live qualification. A pre-existing
complete `DIM_SMOKE_CONFIG` with explicit `DIM_SMOKE_HOSTS` remains the direct
entry point for coordinator-prepared acceptance fixtures.

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
