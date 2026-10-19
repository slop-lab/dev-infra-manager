# Examples

- [Ordinary remote development](projects/basic-development/README.md) uses the
  base Git workspace, explicit development commands and local forwarding.
- [Native Project](projects/native-basic-root/README.md) adds proposal Git,
  human review and candidate-controlled ordinary or QEMU jobs.
- [Multiple repositories](projects/native-multiple-repositories/README.md)
  groups independent public/private repositories in one Project, with separate
  workspace grants and an exact joint CI snapshot.
- [Codex](use-cases/codex/README.md) installs the reviewed coding tool explicitly
  into a workspace's persistent home.
- Optional feature examples live under `features/` with their owning
  integration. They do not change the base workspace lifecycle.

The native Project fixture has source checks in
`tests/scenarios/harness/nativeBasicExample.test.mjs`. Real Git, runtime, service and
CI verification require their declared disposable host prerequisites; source
structure checks alone do not establish runtime or multi-host acceptance.

## Required components

Install optional packages on the selected development host, where DIM executes
workspace commands. Installing a package on the SSH client alone does not make
it available remotely. Versions below match this checkout's `0.10.0` release;
source installations should use the matching prepared package set.

| Example | Host plugins | Other required components |
| --- | --- | --- |
| [Basic development](projects/basic-development/README.md) | None | Base DIM, Docker with Sysbox, built workspace image; SSH access for a remote host |
| [Native basic repository](projects/native-basic-root/README.md) | None | Native Git and CI worker host plugins plus operator tools via `dim installer install core --with-managed`; connected native Git/control-plane services; managed service's `@slop-lab/dim-control-plane-plugin-ci-workflows` compiler; configured Sysbox and QEMU/KVM CI slots for both required jobs |
| [Multiple repositories](projects/native-multiple-repositories/README.md) | None | Managed integration, connected native Git service and its CI workflow compiler; Sysbox workspace image; shared execution service and Sysbox worker to run CI |
| [Codex](use-cases/codex/README.md) | `@slop-lab/dim-host-plugin-agent-tools@0.10.0` | Base workspace prerequisites; guest tool installation network access and deliberate Codex authentication; guest SSH setup for remote editors |
| [External URLs](features/external-urls/README.md) | `@slop-lab/dim-host-plugin-external-urls@0.10.0` | Managed administration and its host controller, an owned workspace, configured ingress; no native Git/control-plane service required |
| [Shared execution](features/shared-execution/README.md) | None | Managed CI service/compiler composition, private worker connection, reviewed runner/job images; Docker/Sysbox for container slots or Docker and functional KVM for VM slots |
| [Archived route policy](features/external-url-route-policy/README.md) | External-URLs plugin for a separately configured integration | Historical standalone policy-server fixture; Node.js 24/26 and a private Unix socket; not a complete deployment recipe |

The recognized repository declaration is `.dim/workspace.json`, for example:

```json
{"plugins":["@slop-lab/dim-host-plugin-agent-tools@0.10.0"]}
```

Only exact registry package versions belong in `plugins`. DIM checks the
configuration repository before creating a workspace and asks before installing
missing plugins. An empty list explicitly means no host plugins are required;
it does not provision managed services, CI workers, images or tool credentials.
In particular,
`@slop-lab/dim-control-plane-plugin-native-git` and
`@slop-lab/dim-control-plane-plugin-ci-workflows` are control-plane plugins installed
with `dim installer install control-plane plugin PACKAGE@EXACT_VERSION`, using
the standalone control-plane runtime without workspace core. See
[plugin locations](../docs/guides/plugin-scopes.md).
Feature recipes applied to an arbitrary
repository document their plugin installation steps instead of adding a
manifest to that unrelated source.

## What the checks establish

Run focused commands below from the repository root after installing the locked
workspace dependencies. These source tests import the named components from
this checkout; they do not require globally installing those plugins or logging
in to a provider. The complete source gate is documented in
[verification profiles](../docs/development/verification.md).

| Example / check | Required test components and scope |
| --- | --- |
| Native basic: [policy/workflow check](../tests/scenarios/harness/nativeBasicExample.test.mjs) | Managed policy compiler plus CI-workflows compiler; checks the committed example and required job agreement, without Docker, KVM or live services |
| [Multiple repositories](projects/native-multiple-repositories/README.md): [linked integration](../tests/scenarios/ci/multipleRepositoryExample.test.ts) | Native Git service, managed CI and CI-workflows compiler from source; real disposable local Git/HTTP plus the committed integration script; no host plugin, installed control plane or Docker required |
| Multiple repositories: [physical workspace test](../tests/host/core/multiRepositoryWorkspaceRuntime.test.ts) | The same managed/native components plus Docker/Sysbox, a built workspace image and matched package outputs; opt in with `DIM_NATIVE_MULTI_REPOSITORY_IMAGE`; proves checkout isolation, repository grants, pushes and persistent recreation |
| External URLs: [plugin tests](../tests/host/plugins/external-urls) and [relay smoke](../scripts/checks/controller-workspace-relay-smoke.mjs) | Tests import the external-URLs plugin and managed controller from source. The relay smoke additionally needs matched built packages and a Sysbox workspace image; it does not need native Git, DNS or CI |
| Codex: [agent-tools tests](../tests/host/plugins/agent-tools) | Agent-tools source and disposable local helper processes; tests exercise configuration and launch behavior, without authenticating Codex or claiming live provider inference |
| Archived route policy: [protocol tests](../tests/host/plugins/external-urls/routePolicy.test.ts) | External-URLs plugin source and a local Unix socket; protocol coverage does not establish a deployed public ingress |

```sh
pnpm --dir verification exec vitest run test/nativeBasicExample.test.mjs
pnpm --dir tests exec vitest run packages/core/test/ci/multipleRepositoryExample.test.ts
DIM_NATIVE_MULTI_REPOSITORY_IMAGE=YOUR_BUILT_IMAGE \
  pnpm --dir tests exec vitest run packages/core/test/multiRepositoryWorkspaceRuntime.test.ts
```

The ordinary-development and shared-worker instructions are deployment recipes,
not independent end-to-end test fixtures. A source/compiler test alone does not
prove a worker ran a job; use the physical runtime and worker verification
profiles for that claim.
