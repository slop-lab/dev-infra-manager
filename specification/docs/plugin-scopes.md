# Host and control-plane plugins

Plugins declare their execution location through their package name and export.
Workspace commands use host plugins; shared services use control-plane plugins.
Installing one does not enable the other location's implementation.

| Package | Location and responsibility |
| --- | --- |
| `@slop-lab/dim-control-plane` | Standalone service plugin runtime; loading, capability validation and shutdown |
| `@slop-lab/dim-plugin-control-plane-native-git` | Repository storage, scoped Git transport, review and protected-ref promotion |
| `@slop-lab/dim-plugin-control-plane-ci-workflows` | Repository workflow language compiler consumed by native Git |
| `@slop-lab/dim-plugin-control-plane-llm-router` | Upstream accounts and secrets, routing, admission, usage and exchange capture |
| `@slop-lab/dim-plugin-host-llm-router` | Workspace identity checks, scoped router enrollment, local gateway and guest/OpenCode configuration |

The workflow compiler does not execute jobs. Shared execution services and
workers retain their own configuration, capacity and runtime boundaries.

## Install on the selected machine

The installer facade can install control-plane plugins on a machine that has
never installed `dim-core`, `dim-cli` or `dim-managed`:

```bash
dim installer install control-plane plugin \
  '@slop-lab/dim-plugin-control-plane-native-git@0.10.0' \
  '@slop-lab/dim-plugin-control-plane-ci-workflows@0.10.0'
```

This installs the matching standalone runtime and selected plugins in a separate
control-plane tree. `--local-packages DIRECTORY` selects the reviewed source
bundle's exact dependency closure. The installer prints its executable path.
`DIM_CONTROL_PLANE_PLUGIN_HOME` overrides that tree; otherwise it lives under
`DIM_DATA_HOME/control-plane/runtime/current` (the usual user data directory
supplies `DIM_DATA_HOME` when omitted).

Manage that plugin selection with:

```bash
dim installer control-plane disable-plugin '@slop-lab/dim-plugin-control-plane-native-git'
dim installer control-plane enable-plugin '@slop-lab/dim-plugin-control-plane-native-git'
dim installer control-plane remove-plugin '@slop-lab/dim-plugin-control-plane-native-git'
```

Restart the control-plane process after changing its enabled plugin selection.
Run its private service configuration with `dim-control-plane run FILE`, using
the executable path printed by installation. See the
[runtime configuration](../../core/packages/control-plane/README.md).
The existing `dim installer install control-plane --config FILE` command owns
the separate Docker deployment/activation transaction.

Host plugins use `dim installer install plugin PACKAGE@EXACT_VERSION` on the
host that owns the workspace. Its host plugin manifest is separate from the
control-plane manifest. `.dim/workspace.json` declares required host plugins
only; a repository cannot install or activate control-plane code as a side
effect of workspace creation. Install and configure the required shared services
deliberately before selecting `dim://` sources or remote router connections.

## LLM router connection

The control-plane router owns backend account keys and operator operations.
It grants a host issuer access to explicit project/route pairs. The host adapter
enrolls only its selected workspace identity and keeps the resulting upstream
principal token in private host state. Guests receive a separate gateway token.

The host gateway validates the immutable workspace UUID and running state before
forwarding and while streaming. Discard, stop or same-name replacement fences
the old workspace. Guest headers cannot select another project/account or
replace the host's router credential. The remote router does not read the host's
workspace store, and the host adapter does not need backend account keys or
router database access. Each side can be installed and restarted independently.

## Verification

The source tests cover plugin startup/cleanup and enabled-package selection,
native Git startup without workspace packages, independent packaged installation,
and router-to-host gateway authorization. The artifact profile smoke installs
real control-plane packages into an empty user tree before installing any host
components. The public/private [example](../../examples/projects/native-multiple-repositories/README.md)
uses the actual native Git and workflow plugins in linked Git/CI verification.
