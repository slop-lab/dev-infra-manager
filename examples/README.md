# Executable DIM recipes

Every entry in [`catalog.json`](catalog.json) owns a `recipe.json`, runnable
`scripts/`, and any repository templates or trusted operator policy files it
uses. The declaration is consumed by both installation and linked verification;
the documentation is not a second plugin inventory.

| Recipe | What its fast stage establishes | VM journey |
| --- | --- | --- |
| [Ordinary development](projects/basic-development/README.md) | Checked-in ordinary repository script | Installed CLI, workspace and script |
| [Native basic](projects/native-basic-root/README.md) | Declared plugins, real Git import/grant, pinned workflow script | Installed CLI, native source and workspace script |
| [Multiple repositories](projects/native-multiple-repositories/README.md) | Actual public/private trees and policies, exact CI inputs, isolation and incompatible combination | Both selected repositories and integration script |
| [Codex](use-cases/codex/README.md) | Real helper installation and workspace identity fencing | Explicit tool/network/account prerequisites |
| [External URLs](features/external-urls/README.md) | HTTP route approval boundary | Explicit ingress and approval prerequisites |
| [Route policy](features/external-url-route-policy/README.md) | Actual Unix HTTP allow/rewrite/deny | Operator service; no implicit deployment |
| [Shared execution](features/shared-execution/README.md) | Actual Git/CI admission, results and recovery | Explicit worker/image/runtime prerequisites |

## Run a recipe

Install the locked monorepo dependencies first. Node.js 24/26 runs the small
TypeScript runner directly. No recipe is executed merely by loading its JSON.

```bash
node scripts/examples/run.ts examples/projects/native-multiple-repositories verify
node scripts/examples/run.ts all verify
```

`verify` is the daily, local source gate: it exercises real Git/HTTP or local
scripts without Docker/KVM, account credentials or installing packages. The
native integration tests read the recipe's plugin selections, source trees and
policy files. Their source registry composes the declared repository-side
plugins; it does not assert that host plugins or the standalone CI coordinator
were installed. Actual installed-package integration belongs to the VM journey.

Install the recipe's plugins on their owning machines explicitly:

```bash
node scripts/examples/run.ts examples/projects/native-multiple-repositories install-host
node scripts/examples/run.ts examples/projects/native-multiple-repositories install-control-plane
```

The host already needs base DIM and the native examples need control-plane
administration (`dim installer install core --with-managed` is the convenience
profile). Control-plane plugins install into their independent runtime. These
commands install packages; they do not invent credentials, log in, configure
external services or start listeners. With reviewed source artifacts, set
`DIM_EXAMPLE_PACKAGE_BUNDLE` to the directory containing `packages.json` and its
tarballs. The facade validates the exact declared package versions and dependency
closure. A local-version bundle is not silently substituted for `0.10.0` recipes.
`DIM_EXAMPLE_DIM_BIN` selects the actual installer facade/CLI executable.

For a workspace recipe's deliberate development setup:

```bash
export DIM_EXAMPLE_WORK="$(mktemp -d)"
node scripts/examples/run.ts examples/projects/native-multiple-repositories dev
```

Native recipes require a saved, live control-plane connection before `dev`.
Templates are copied into the fresh operator directory, committed as independent
Git repositories, imported with the declared policies, and selected through the
installed CLI. Operator policies are copied into fresh mode-0600 files under the private
operator work directory; checked-in policy files keep their original permissions
and stay outside candidate repositories. The
workspace remains available after `dev`; discard it deliberately when finished.
`DIM_EXAMPLE_PROJECT` and `DIM_EXAMPLE_WORKSPACE` override its names;
`DIM_EXAMPLE_WORKSPACE_IMAGE` selects an already built image.

## Installed-package acceptance

After a matching `pnpm run workspace:build`, a Linux host with Docker/Sysbox can
exercise the actual installed-package path without replacing its DIM installation:

```bash
bash scripts/examples/verify-installed.bash
```

This creates a private source-package bundle and installer prefix, installs the
declared host/control-plane plugins, builds a matching disposable workspace image,
starts temporary services from the installed control-plane tree, and runs the
workspace recipes through the installed CLI. It removes its temporary image,
workspaces, controller and private state afterward. It requires network access for
locked package/image dependencies and does not authenticate external providers.
This Sysbox acceptance is distinct from running the same journey in a fresh VM.

## VM acceptance

`run.ts all verify-vm` selects only recipes with that stage. Each creates its
workspace and discards it in an exit trap, including failures. `DIM_EXAMPLE_WORK`
is scoped by recipe name when using `all`. The default complete journeys are
ordinary, native basic, and multiple repositories. Provider/service recipes
expose executable `dev` and `verify` commands and document their prerequisites;
they do not pretend an unconfigured provider is an accepted VM scenario.

The ordinary source gate runs `all verify` on every source check, including
development pushes, so recipe commands are exercised rather than only parsed.
Run `just verify examples-vm-preflight` to discover readiness and workspace
setup instructions, then `just verify examples-vm` for the fresh Ubuntu/KVM
gate. The wrapper boots a standalone control-plane VM and an independent host
VM at the same time. It prepares exact installed packages, a matching workspace
image and remote native services before invoking these stages on the host VM. This heavy
acceptance gate is required before merging to main and before release, rather
than on every daily development check. It verifies workspace integration using
the installed artifacts. It does not substitute for functional-KVM CI runner
verification or provider/account acceptance.

The gate also runs from an explicitly KVM-enabled DIM workspace; see the
[workspace setup and commands](../scripts/development.md#kvm-example-verification-inside-a-workspace).
The ordinary `container` runtime intentionally has no KVM device.

Generic runtime support is documented in [verification](../docs/development/verification.md).
Only exact host-plugin requirements belong in a repository's optional
`.dim/workspace.json`; recipe declarations also name control-plane plugins and
operator stages and are not automatically recognized candidate configuration.
