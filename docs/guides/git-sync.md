# External Git synchronization

The optional `@slop-lab/dim-control-plane-plugin-git-sync` attachment connects a
managed repository to one reviewed upstream. It owns fetching, merge proposal
creation and nonforce publication. Repository storage owns protected refs;
code-review and merge-policy own approval and promotion. Git synchronization
does not require CI or a workspace runtime.

## Install and configure

DIM's managed control-plane image includes this attachment. New
`dim control-plane prepare` configurations generate a separate synchronization
operator for the prepared host. After installation, `dim control-plane connect`
verifies its live host and generation identity and writes private `git-sync.json`
beside `host.json`. Fetch, sync and publish commands use that connection
automatically; no additional connection option is needed.

For an existing managed installation, add the following section to its private
`native-git.json`. Keep the operator's `hostId` equal to the host that will run
synchronization commands, and generate a unique operator username and secret:

```json
{
  "gitSync": {
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
Every role must use distinct credentials. Keep `native-git.json` mode 0600,
outside the repository and workspace. Public fetching needs no upstream
credential; publishing requires a provider credential with write access to the
intended repository. The provider credential stays in the private control-plane
configuration and is never included in host connection files or workspaces.

Redeploy the reviewed service configuration, then reconnect into a new directory
so the connections bind to the new generation:

```bash
dim installer install control-plane --config /absolute/setup/install.json
dim control-plane connect /absolute/setup \
  --output-directory /absolute/setup/connections-updated
```

`connect` selects the generated host connections automatically. Existing service
configurations without `gitSync`, or with an empty operator list, still validate
upstream and publish policy but grant no synchronization authority.

An independently composed control plane can install
`@slop-lab/dim-control-plane-plugin-git-sync@0.10.0` alongside the Git repositories
plugin, then select it in the private runtime's `plugins` array. Its `config`
contains the same `operators`, optional `credential`, and optional
`allowLocalRemotes` fields as the managed `gitSync` section above. Review and
promotion plugins remain separate optional services selected by repository
policy.

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

The example above maps managed `main` to GitHub `development`. This source
repository's own declaration selects repository `main`, managed `development`
and reviewer `mjy` to match its installed Project.
The example's `.dim/` path rule requires `owner` review for configuration changes. Other
changes require no human approval but still pass the normal current-review and
promotion checks. Protect review matcher dependencies and scripts that can
change a secret boundary explicitly, including dependencies outside `.dim/`.
The [security-review example](../../examples/features/security-review/README.md)
shows that configuration for a secret-bearing secure runtime.

## Update an existing repository's policy

Import is not required again when upstream mappings or review rules change.
On the trusted operator host, inspect the live effective policy and preview the
current working tree's `.dim/repos.yml` before applying it:

```bash
dim project repository policy show dim main --json
dim project repository policy update dim main --preview --json
dim project repository policy update dim main
```

The default file is `.dim/repos.yml` relative to the command's current directory
on the selected host. Unlike `import --repository-policy`, this explicit update
reads the current file, including uncommitted edits. To select another reviewed
YAML manifest or an existing JSON policy declaration:

```bash
dim project repository policy update dim main --file /absolute/reviewed-repos.yml --preview
dim project repository policy update dim main --file /absolute/reviewed-repos.yml
dim project repository policy update dim main --policy /absolute/repository-policy.json
```

JSON uses the import format `{ "schemaVersion": 1, "repositoryId": "main",
"extensions": { ... } }`. It replaces the complete extension policy, rather
than merging individual fields. YAML must name the selected repository and
protect its existing branch. Changing the protected branch requires a separate
repository, not a policy update. Files must be caller-owned regular files,
without symlinks, multiple hard links or group/world write permission.

The selected private importer connection authorizes updates. `--connection`
selects another root importer connection, which must attest the same host,
endpoint and generation. Workspace Git credentials cannot revise policy.
The server validates enabled feature policies and compares the current policy
digest and protected commit before committing the update. A concurrent change
requires another preview/update. Old review evidence no longer authorizes
promotion under a changed policy. Git history, data and original import receipts
are preserved; the host catalog records the new effective policy separately.
If the server accepted an update but the host refresh failed, repeat the same
command to reconcile it safely. A file edit or an ordinary Git push never
applies configuration by itself.

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
