# Repository configuration ownership

| File | Reader |
| --- | --- |
| `repos.yml` | `@slop-lab/dim-host-plugin-native-git`; explicit `project repository import --repository-policy` or `project repository policy update`; upstream/publish operations belong to the optional control-plane `git-sync` plugin |
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
`repos.yml` here declares repository `main` with managed `development`, GitHub
`development` as its upstream and publication target, and `mjy` review for `.dim/` changes. Other changes
need no human approval. The declaration takes effect only after reviewed
import or an explicit policy update; fetch, sync and publish are explicit plugin commands. Credentials remain
in private operator/service configuration. See [Git synchronization](../docs/guides/git-sync.md).

Developer commands live in [`scripts/development.md`](../scripts/development.md) and `scripts/dev.bash`.
Host-run QEMU verification mechanics live in [`tests/scenarios/qemu`](../tests/scenarios/qemu).
Those helpers are explicit repository tooling, not DIM Project configuration.

For KVM acceptance inside a workspace, start with
`bash scripts/dev.bash verify-vm --preflight-only`. The
[development guide](../scripts/development.md#kvm-example-verification-inside-a-workspace)
explains the operator-selected `container-kvm` runtime and the separate
control-plane/host VM topology. No repository file grants access to host KVM.
