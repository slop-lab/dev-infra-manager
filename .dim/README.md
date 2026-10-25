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
need no human approval. The explicit `git-ci` policy requires successful DIM CI
for the candidate-controlled `source` job before either managed branch can be
promoted. Merely having `ci/runner.yml`, an approved review, a configured worker,
or successful GitHub CI does not satisfy that gate. The declaration takes effect only after reviewed
import or an explicit policy update; fetch, sync and publish are explicit plugin commands. Credentials remain
in private operator/service configuration. See [Git synchronization](../docs/guides/git-sync.md).

This source declaration does not change a running control plane. Enable it with
an explicit reviewed repository policy update only after matching Git/execution
services and trusted worker capacity are ready. Existing jobs from a prior
generation or changed policy are historical evidence, not a successful check for
a new candidate. Keep admission failures and stale attempts visible and resolve
a fresh review after enabling policy. The operator owns worker images, resource
bounds and credentials; candidate workflow files select only bounded job scripts
and arguments. See [DIM CI capacity and merge gates](../docs/guides/ci-runners.md).

Developer commands live in [`scripts/development.md`](../scripts/development.md) and `scripts/dev.bash`.
Host-run QEMU verification mechanics live in [`tests/scenarios/qemu`](../tests/scenarios/qemu).
Those helpers are explicit repository tooling, not DIM Project configuration.

For KVM acceptance inside a workspace, start with
`bash scripts/dev.bash verify-vm --preflight-only`. The
[development guide](../scripts/development.md#kvm-example-verification-inside-a-workspace)
explains the operator-selected `container-kvm` runtime and the separate
control-plane/host VM topology. No repository file grants access to host KVM.
