# Repository configuration ownership

| File | Reader |
| --- | --- |
| `repos.yml` | `@slop-lab/dim-host-plugin-native-git`; explicit reviewed-manifest bootstrap API only, not ordinary workspace creation or CLI import |
| `ci/runner.yml` | `@slop-lab/dim-control-plane-plugin-ci-workflows`; optional Git CI compiles candidate jobs, whose payloads live in [`scripts/ci`](../scripts/ci) |
| `workspace.json` (optional; absent here) | Selected-host CLI composition; exact required host plugin packages, with explicit installation approval |
| `README.md` | Human documentation only; DIM does not parse it |

The reviewed configuration files grant no host authority and do not start
development tasks automatically. Ordinary repositories need none of them.
`workspace.json` supports only `{"plugins":["PACKAGE@EXACT_VERSION"]}`;
missing plugins stop creation before any workspace record or runtime exists.
An interactive operator may approve installation on the selected host. Paths,
URLs, version ranges and executable hooks are not declaration inputs.

The [repository configuration guide](../docs/guides/repository-configuration.md)
documents the schemas, activation rules, plugin boundaries and project-owned
review/script files. The host core interprets none of the plugin-specific YAML.
`repos.yml` here declares only the reviewed `root` branch policy; repository
connections and import/publish settings are managed through plugin commands.

Developer commands live in [`scripts/development.md`](../scripts/development.md) and `scripts/dev.bash`.
Host-run QEMU verification mechanics live in [`tests/scenarios/qemu`](../tests/scenarios/qemu).
Those helpers are explicit repository tooling, not DIM Project configuration.

For KVM acceptance inside a workspace, start with
`bash scripts/dev.bash verify-vm --preflight-only`. The
[development guide](../scripts/development.md#kvm-example-verification-inside-a-workspace)
explains the operator-selected `container-kvm` runtime and the separate
control-plane/host VM topology. No repository file grants access to host KVM.
