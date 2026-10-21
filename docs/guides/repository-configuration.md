# Repository `.dim` files

Ordinary Git workspaces need no `.dim` directory. DIM reads specific files for
specific capabilities; the directory is not a collection of executable hooks.
Installing a plugin on the host can also provide workspace tools without any
repository declaration. Unknown files are ordinary checkout content.

| Path | Owner | When it is read |
| --- | --- | --- |
| `.dim/workspace.json` | `@slop-lab/dim-cli` host composition | Workspace creation checks exact required host plugins in the acquired checkout before creating runtime resources. |
| `.dim/repos.yml` | `@slop-lab/dim-host-plugin-native-git` | An explicitly selected `reviewed-manifest` bootstrap or `project repository import --repository-policy` reads the selected commit's Git blob. Ordinary workspace creation does not discover it. |
| `.dim/ci/runner.yml` | `@slop-lab/dim-control-plane-plugin-ci-workflows` | Git CI selects the `dim` workflow compiler to compile the immutable candidate's jobs. |
| `.dim/ci/jobs/*` | The repository | Example job scripts run only when a workflow names them. Scripts can instead live elsewhere in the repository. |
| `.dim/security-boundary.json` | The security-review example | Its trusted `boundary.ts` operator launcher reads reviewed configuration; the `.dim/` path rule requires review of changes. DIM does not discover this filename. |
| `.dim/review/*` | The repository and its selected review matcher/runtime | Operator-configured review policy names the entrypoint and its inputs explicitly. This directory has no automatic discovery behavior. |
| `.dim/README.md` | The repository | Human documentation; no DIM component parses it. |

The host core owns workspace lifecycle, storage and extension composition. It
does not interpret repository lists, workflow YAML or review matcher settings.
Plugin-specific configuration and defaults belong to the owning plugin.

## Required host plugins: `workspace.json`

```json
{
  "plugins": [
    "@slop-lab/dim-host-plugin-agent-tools@0.10.0"
  ]
}
```

The only field is `plugins`, an array of at most 32 unique package names with
exact versions. The file is limited to 32 KiB. Paths, Git URLs, version ranges,
unknown fields and symlinked declarations are rejected. A missing file means
no repository-required plugins; already installed host integrations still work.

This declares host prerequisites. Control-plane installation, authentication,
mount/device grants and credentials remain operator decisions. Missing packages
stop creation; an interactive operator may approve installation on the selected
host. Noninteractive creation never approves installation. DIM rechecks the
source commit after approval. See [the CLI contract](../../packages/cli/core/README.md#required-workspace-plugins).

For a multi-repository Native Git Project, this declaration comes from the
Project's selected configuration repository, including when that repository is
not among the workspace's selected checkouts. It is not merged from every repo.

## Native Git repository policy: `repos.yml`

The Native Git host plugin supports a reviewed, commit-pinned policy file:

```yaml
schemaVersion: 1
repositories:
  root:
    ref: main
    protect: [main]
    upstream:
      url: https://github.com/slop-lab/dev-infra-manager.git
      branch: development
    publish: {main: development}
policy:
  code-review:
    requiredReviewerIds: []
    pathReviewerRules:
      - pathPrefix: .dim/
        reviewerIds: [owner]
  merge-policy: {}
```

`schemaVersion` must be `1`. `repositories` is a nonempty map keyed by repository
ID. Each entry requires `protect`, containing 1–64 branch patterns (`*` and `?`
are supported); the selected branch must match. Optional `ref` must match the
selected branch after normalization to `refs/heads/...`. Unknown fields fail.
Each pattern is limited to 512 characters; the whole manifest is at most 64 KiB.

Optional top-level `policy` carries namespaced feature declarations for the
selected repository. It becomes that repository's `extensions` policy and is
bound into its policy revision. Enabled control-plane plugins validate their
own namespaces, such as `code-review`, `git-ci` and `merge-policy`.

Optional repository `upstream` and `publish` fields compile into the `git-sync`
policy namespace, owned by the optional control-plane Git synchronization plugin.
`upstream` selects a URL and branch; `publish` maps managed branches to upstream
branches. The example publishes managed `main` to GitHub `development`. Do not
also set `policy.git-sync` when using these fields. Endpoint credentials and
permitted operator identities belong in private service configuration. See
[Git synchronization](git-sync.md) for installation and commands.

Select the policy explicitly during repository import:

```bash
dim project repository import dim root --source /absolute/checkout \
  --ref refs/heads/main --repository-policy
```

The selected branch must exist in the import checkout. For this repository,
prepare a fresh clone of GitHub `development` and create local `main` at that
commit before importing; the [synchronization guide](git-sync.md#reviewed-repository-declaration)
shows the commands without changing an existing checkout.

`--repository-policy` and `--policy /absolute/policy.json` are mutually exclusive.
Without either option, import uses empty feature declarations. The manifest
loader reads a regular Git blob from the same selected commit it bundles;
worktree edits cannot replace reviewed policy. The bootstrap APIs also accept
`policySource: { kind: "reviewed-manifest" }`. The map selects one repository per
import; it does not clone or import its other entries.

The example requires the `owner` reviewer for `.dim/` changes and no human
reviewers for other changes. A candidate still needs a current review and a
merge-policy-authorized promotion; an empty reviewer set makes review automated.
Configured quality gates can independently block promotion. Protect matcher
code and dependencies outside `.dim/` explicitly if they influence security
review. The [security review example](../../examples/features/security-review/README.md)
shows that boundary for a secret-bearing secure runtime.

Project creation, repository import and source configuration are separate plugin
operations, as shown by the [multiple-repository example](../../examples/projects/native-multiple-repositories/README.md).
The host core does not interpret this manifest and has no `--apply-repos` option.

## Candidate workflow: `ci/runner.yml`

```yaml
jobs:
  source:
    script: scripts/ci/source.bash
  integration:
    script: .dim/ci/jobs/integration.bash
    runtime: vm
    repositories: [public, private]
```

The only top-level field is `jobs`, with at most 64 named jobs. Each job requires
a repository-relative `script`; optional `runtime` is `container` (the default)
or `vm`. Optional `repositories` selects up to 64 unique Project repository IDs.
The primary repository is always included; trusted repository policy must
authorize every additional repository. Unknown fields and unsafe script paths
fail compilation. YAML is strict UTF-8 and limited to 64 KiB.

The compiler owns this path and syntax. Git CI owns immutable candidate inputs;
execution workers consume the compiled plan. Another compiler can choose its
own path and language. Candidate YAML does not select privileged mounts,
credentials or host resource limits. See the [workflow plugin](../../packages/control-plane/plugins/ci-workflows/README.md).

Each repository's candidate supplies its own workflow. A job requests additional
repositories through `repositories`; their workflow files do not add jobs to
the primary repository's plan.

## Review code and repository tooling

`.dim/review/matcher.ts`, `matcher.mjs`, helper modules and settings are ordinary
project files. A configured matcher/runtime decides which ones to read. Review
policy must protect the matcher and relevant dependencies independently of its
own verdict. The [security review](../../examples/features/security-review/README.md)
and [TypeScript tracing](../../examples/features/review-tracing/README.md)
examples show explicit entrypoints, field checks and observed dependency reads.
The security-review example keeps secrets in `secure-dind`, outside the coding
agent's `agent-dind`. Its project-owned `.dim/security-boundary.json` describes
the reviewed boundary. Its `.dim/` path rule requires `security` review of
boundary and matcher changes; separate matchers protect selected application
fields. The filename has no built-in DIM meaning.

Keep this distinction visible in repository documentation: name each file's
owning plugin, the command or policy that activates it, and any scripts it
references. Developer commands such as `scripts/dev.bash`, example installation
recipes and KVM verification scripts remain repository tooling even when they
read files under `.dim`.
