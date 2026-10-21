# External Git synchronization

The optional `@slop-lab/dim-control-plane-plugin-git-sync` attachment connects a
managed repository to one reviewed upstream. It owns fetching, merge proposal
creation and nonforce publication. Repository storage owns protected refs;
code-review and merge-policy own approval and promotion. Git synchronization
does not require CI or a workspace runtime.

## Install and configure

DIM's managed control-plane image already includes this attachment with an empty
operator list. This accepts reviewed upstream/publish policy during manifest
import, while granting no synchronization authority. To enable fetch, merge or
publish commands, use an explicit service composition with the private operator
configuration below; the managed preset does not provision that connection.

On the control-plane machine, install the attachment alongside repository
storage and the review/promotion services used by the Project:

```bash
dim installer install control-plane plugin \
  '@slop-lab/dim-control-plane-plugin-git-repositories@0.10.0' \
  '@slop-lab/dim-control-plane-plugin-git-sync@0.10.0' \
  '@slop-lab/dim-control-plane-plugin-code-review@0.10.0' \
  '@slop-lab/dim-control-plane-plugin-merge-policy@0.10.0'
```

Select `git-sync` in the same private runtime configuration as the repository
service. The following is one entry in the runtime's `plugins` array:

```json
{
  "package": "@slop-lab/dim-control-plane-plugin-git-sync",
  "config": {
    "operators": [
      {
        "hostId": "operator-host",
        "username": "git-sync-operator",
        "password": "REPLACE_WITH_RANDOM_32_BYTE_BASE64URL_SECRET"
      }
    ],
    "credential": {
      "username": "github-account",
      "password": "REPLACE_WITH_PROVIDER_TOKEN"
    }
  }
}
```

Generate operator passwords with `randomBytes(32).toString('base64url')` from
Node's `node:crypto` module. Operator credentials authorize DIM synchronization
commands; the optional upstream credential authenticates HTTPS Git transport.
Keep this file private, outside the repository and workspace. Select a provider
token with access only to the intended repository. Public fetching needs no
upstream credential; publishing requires the provider to authorize writes.
Restart the control plane after changing configuration.

Production remotes use credential-free HTTPS URLs without query strings or
fragments. `allowLocalRemotes: true` enables local file remotes explicitly for
trusted operator environments and disposable integration fixtures. It is off by
default. Repository YAML cannot select credential files or arbitrary transport
commands.

## Reviewed repository declaration

The Native Git host plugin reads `.dim/repos.yml` only when explicitly selected:

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

Prepare a fresh import checkout on the selected host. This creates a local
`main` at the reviewed `development` commit without changing an existing checkout
or either remote branch. Choose an unused absolute destination:

For a new Project, first run `dim project create dim`. Reuse the Project's name
when operating on an existing registration.

```bash
git clone --branch development --single-branch \
  https://github.com/slop-lab/dev-infra-manager.git /absolute/dim-import
git -C /absolute/dim-import switch -c main
dim project repository import dim root --source /absolute/dim-import \
  --ref refs/heads/main --repository-policy
dim project configure dim --configuration-repository root --default-repository root
```

The checkout must contain the selected `main` branch, even though the external
branch is named `development`. The importer reads committed Git blobs, including
the manifest. The manifest's upstream and publication declaration become the
repository's revision-bound `git-sync` policy. `--policy FILE` is an alternative
to `--repository-policy`; a plain import selects neither automatically.

This repository's declaration maps managed `main` to GitHub `development`.
The `.dim/` path rule requires `owner` review for configuration changes. Other
changes require no human approval but still pass the normal current-review and
promotion checks. Protect review matcher dependencies and scripts that can
change a secret boundary explicitly, including dependencies outside `.dim/`.
The [security-review example](../../examples/features/security-review/README.md)
shows that configuration for a secret-bearing secure runtime.

## Fetch, merge, publish

Install `@slop-lab/dim-host-plugin-native-git@0.10.0` on the operator host. Its
CLI supplies these commands using a private operator connection file:

```bash
dim project repository fetch dim root --connection /absolute/git-sync.json
dim project repository sync dim root --connection /absolute/git-sync.json
dim project repository publish dim root --connection /absolute/git-sync.json
```

The connection must be an operator-owned regular file with mode `0600`:

```json
{
  "schemaVersion": 1,
  "serviceId": "native-main",
  "role": "git-sync-operator",
  "hostId": "operator-host",
  "generationId": "REPLACE_WITH_CURRENT_64_CHARACTER_HEX_GENERATION",
  "endpoint": "https://control-plane.example",
  "credential": {
    "username": "git-sync-operator",
    "password": "REPLACE_WITH_MATCHING_OPERATOR_SECRET"
  }
}
```

Its endpoint, generation and host must match the host's selected control plane.
HTTPS is required except for loopback HTTP. The credential matches a configured
`operators` entry; it is separate from the upstream provider token. Omitting
`--connection` selects `DIM_NATIVE_GIT_SYNC_CONNECTION_FILE`, then `git-sync.json`
next to the selected importer connection. This file stays outside workspaces.

`fetch` updates the repository's `upstream/...` tracking ref from the reviewed
upstream branch. It does not change managed `main`.

`sync` fetches first. Already incorporated history returns `unchanged`. A clean
merge creates an ordinary proposal for the combined history and returns
`proposed`; review and promotion proceed through the existing services. No
synchronization command directly advances a protected ref. A merge conflict
returns `conflict` (CLI exit status `2`) and keeps protected history unchanged;
resolve the conflict in a normal workspace and submit its proposal.

New managed workspaces whose imported policy enables `git-sync` fetch the
service's upstream tracking refs automatically. After an operator runs `fetch`,
a developer can merge inside the workspace:

```bash
git fetch origin
git merge upstream/development
# Resolve conflicts and commit the result if necessary.
git push
```

`origin` remains the workspace's scoped DIM connection. No upstream provider
credential enters the workspace, and the push follows the normal proposal and
review path. Existing workspaces can opt into the same tracking refspec once:

```bash
git config --add remote.origin.fetch '+refs/remotes/upstream/*:refs/remotes/upstream/*'
git fetch origin
```

The service exposes upstream tracking refs for reads only. Workspace pushes
cannot change the service's `refs/remotes/upstream/...` namespace.

`publish` reads the authoritative protected commit and pushes it to the mapped
upstream branch without force. It does not publish an operator's dirty checkout,
a proposal, or an arbitrary SHA. A divergent remote rejects the push: fetch,
merge and promote its changes before retrying publication. `.dim/repos.yml`
selects behavior; editing it does not itself execute a network operation.

Linked tests use disposable local bare remotes and real Git. They exercise
tracking refs, clean and conflicting merges, review-controlled promotion, mapped
publication and nonforce rejection without pushing to GitHub.
