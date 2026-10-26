# Native Git host integration

This host plugin owns Native Project registration and repository bootstrap,
private host connections, scoped workspace proposal brokers, and `dim://Project`
source acquisition. The host core owns workspace lifecycle and storage; the
control-plane repository, code-review and merge-policy plugins own their
respective service capabilities.

Install the package through the host plugin installer. `dim project` manages
Projects and their independently imported repositories. Its `hostPlugin.source`
capability owns the `dim` URL scheme and lazily loads acquisition/broker code.
Only the enabled host-plugin manifest authorizes source acquisition, recovery
and optional Project metadata; package presence alone does not activate them.
Ordinary local and remote Git workspaces do not require this integration.

## Discover and attach an existing Project

```bash
dim project discover --json
dim project discover PROJECT --json
dim project attach PROJECT --configuration-repository CONFIG_REPO \
  --default-repository WORKING_REPO
dim create dim://PROJECT dev
```

`discover` reads the authenticated Git service catalog without changing local
state. `attach` fetches fresh authoritative repository evidence, proves readiness
with the selected host's existing workspace authority, and atomically creates a
local Project with explicit configuration/default repositories. `--name NAME`
selects a host-local alias. No source is reimported and no protected ref or policy
changes. Importer, registrar and reviewer roles are not attachment credentials.
Repository evidence retains its original immutable import snapshot and receipt
generation separately from the current effective policy and serving generation.
The complete host attachment operation is bounded to 90 seconds. Its authority
descriptor HTTP read has an 85-second ceiling over the service's 80-second
aggregate full-proof deadline; repository readiness proofs share the same
90-second operation signal and therefore consume only the remaining time. Slow
or numerous repositories fail without publishing partial local Project state.

The Git service owns repository membership, immutable import evidence and access
scope; this plugin owns names and defaults on the selected host. An unchanged
retry retains existing local bytes. Explicit reattachment after a service policy
change refreshes only effective-policy metadata while preserving original import
evidence, snapshots, timestamps and defaults. Conflicting names, aliases,
configuring records, repository sets or defaults fail rather than implicitly
replacing or merging them. Use the existing `project configure` operation for an
intentional defaults change.

Several physical hosts may share an exported `hostId` authority and role bundle.
Discovery is limited to that authority's owned Projects. Attachment neither
transfers ownership nor enables cross-authority access. See the
[cross-host operator flow](../../../../docs/guides/project-workspaces.md#use-an-existing-project-on-another-host).

The plugin exclusively owns `.dim/repos.yml` interpretation. Explicit
`project repository import --repository-policy` and the reviewed-manifest bootstrap
API read the selected commit's policy blob; ordinary workspace creation does not
discover the file. CLI import can instead use operator `--policy` input; the two
options are mutually exclusive. See
[repository configuration](../../../../docs/guides/repository-configuration.md#native-git-repository-policy-reposyml)
for the format and activation rules. Repository connections and multi-repository
imports are explicit commands, separate from this policy file.

The optional control-plane `git-sync` plugin owns external fetching, merge
proposals and publication. This host plugin supplies the operator CLI:

```bash
dim project repository fetch PROJECT REPOSITORY --connection /absolute/connection.json
dim project repository sync PROJECT REPOSITORY --connection /absolute/connection.json
dim project repository publish PROJECT REPOSITORY --connection /absolute/connection.json
```

The selected repository's reviewed upstream and publish mapping determine the
remote. `sync` creates a proposal for the normal review/promotion path; `publish`
pushes the authoritative protected commit without force. Remote credentials
remain private to the control plane. New workspaces with `git-sync` policy also
fetch read-only `upstream/...` tracking refs from their scoped `origin`, allowing
ordinary `git fetch origin` and `git merge upstream/development` before submitting
a proposal. See [Git synchronization](../../../../docs/guides/git-sync.md).

Repository read and proposal-write grants remain private to the host. Workspace
checkouts receive narrow local broker access. Review, registrar, importer and
promoter credentials are never mounted into workspaces. Workspace identity checks
fence name reuse and discard. Optional Project metadata is supplied to generic
host controllers through an injected resolver, rather than a host-core dependency
on Native Git.

## Controller console operations

`dim project console describe --json` discovers the selected control-plane generation, optional reviewer identity, local project catalog and available operations. Only repositories whose readiness the current service proves are advertised; historical import receipts retain their original generation. Host attachment is available without reviewer credentials. Review operations use private `reviewer.json`, optional `promoter.json` and optional `git-sync.json` beside the selected host connection; each role must match its selected endpoint and generation, with host-bound roles also matching the selected host identity. No operator credentials or connection paths are returned.

Existing repositories can explicitly refresh policy without another import:

```bash
dim project repository policy show PROJECT REPOSITORY --json
dim project repository policy update PROJECT REPOSITORY --preview
dim project repository policy update PROJECT REPOSITORY
dim project repository policy update PROJECT REPOSITORY --file /absolute/reviewed-repos.yml
dim project repository policy update PROJECT REPOSITORY --policy /absolute/repository-policy.json
```

The default update reads the current `.dim/repos.yml` on the selected host,
including uncommitted edits. YAML must name this repository and protect its
existing branch. JSON uses the import declaration format and replaces the full
extension policy. Updates use the selected private importer connection and
compare the server's current policy digest and protected commit before writing.
Git history, original import receipts, checkout snapshots and existing workspace
grants are preserved. Old approvals do not authorize the replacement policy.
Repeat the same command to reconcile a host refresh after a lost response. See
[Git synchronization](../../../../docs/guides/git-sync.md) for setup and examples.

Clients pin the discovery result: subsequent discovery may pass `--expected-generation HASH`, and every `dim project console invoke OPERATION --expected-generation HASH --input JSON --json` must pass it. A changed selection fails before role attestation or mutation and requires reconnecting explicitly. Every invocation reloads the local project catalog and validates the requested project and repository; adding an imported repository needs no Web configuration. The shared `@slop-lab/dim-service-client-native-git` owns HTTP/evidence decoding and operation semantics; this plugin owns controller selection and namespace scope. Review and sync invocations validate current scope once per request, without preparing unrelated repository importer/registrar capabilities. No repository readiness or authorization result is cached across invocations.

### Public repository imports

With distinct selected registrar/importer roles available, the console also advertises `projects.create` and `repositories.import`. Projects use their ID as their initial local name. Import a public repository through the same host-owned path from the CLI:

```bash
dim project create examples
dim project repository import examples hello --source https://github.com/octocat/Hello-World.git
dim project repository import examples spoon --source https://github.com/octocat/Spoon-Knife.git --branch main
```

The first imported repository becomes the configuration and default working repository; subsequent imports preserve those defaults. Local source imports still require `--ref`. For URL imports, optional `--ref refs/heads/BRANCH` selects a branch instead of `--branch`. Public acquisition never checks out files, runs hooks or submodules, reads ambient Git credentials, or interprets the remote `.dim/repos.yml`. Default controller policy allows ordinary changes without review and requires the selected reviewer's approval for `.dim/` changes, with the merge-policy integration enabled. A CLI operator may explicitly choose a trusted host `--policy` file; `--repository-policy` is forbidden for URL sources.

URL imports retain private source intent under `native-project-url-imports/`, alongside immutable draft bundles under `native-project-drafts/`. Retry uses the original artifact and proves its existing protected root even when upstream has moved or the prior response was lost. Changing URL, requested branch or an explicit policy is rejected instead of replacing that initial import. Updating an existing repository is a separate reviewed sync operation.

The project console advertises admitted repositories only after the currently
selected service proves readiness. A valid service generation update preserves
their original immutable import receipts; those historical generation IDs do not
hide repositories that the current authority still serves. Console requests
remain fenced to the selected serving generation.

### Import a `.dim/repos.yml` manifest

A reviewed manifest can import several repositories in one action. In **Git
review**, create/select a project, paste or upload the manifest, inspect the
preview, then explicitly import it. The equivalent CLI is:

```sh
dim project repository import-manifest my-project --manifest /absolute/path/.dim/repos.yml --preview --json
dim project repository import-manifest my-project --manifest /absolute/path/.dim/repos.yml --json
```

Each entry must declare `ref` and `upstream: {url, branch}`. Acquisition
uses the public HTTPS upstream branch; DIM imports that commit under the managed
`ref`, so `main` can start from upstream `development`. Per-repository `publish`
and manifest `policy` become the imported policy, including reviewer identities
exactly as supplied. Inspect those identities against the configured service;
DIM does not translate `owner` into another reviewer. This explicit action trusts
the supplied declarative policy; ordinary URL import continues to ignore remote
`.dim/repos.yml`. No repository code, hooks or checkout runs during import.

The initial `ref` and `defaultBranch` are independent: importing `development`
can create a repository whose default branch is `main`. New policies default to
managed `main` and `development` branches, with force pushes forbidden on both.
`main` evaluates configured review rules through the proposal path;
`development` skips human review by default. Override this with per-repository
`branches: {main: {review: true}, development: {review: true}}` and select another
default using `defaultBranch`. `protect` defaults to `[main, development]`;
concrete entries add managed branches. See
[repository configuration](../../../../docs/guides/repository-configuration.md#native-git-repository-policy-reposyml)
for the complete declaration and change matcher behavior.

The preview includes every source, managed ref, complete policy, and proposed
configuration/default repository. A new project's first declared entry supplies
both defaults; an existing project's defaults remain unchanged. All entries are
validated before import starts. Up to 16 repositories and a 64 KiB UTF-8 manifest are
supported. The console accepts at most 96 KiB of encoded JSON input; manifest
operations reserve 1 KiB for transport metadata and reject documents whose JSON
encoding exceeds 95 KiB, including unusually escape-heavy YAML. Imports are sequential and may complete partly before a deadline or
source failure. Retry the same manifest to resume its original durable repository
artifacts. The normalized import plan is immutable; changes are rejected rather
than silently replacing a completed or pending import.

## Pull requests

When the selected repository service has the Git pull requests plugin, the host
plugin exposes `dim project pull-request` (`dim project pr`). Supply the local
project name and repository ID; the host resolves trusted repository scope and
current service generation using its existing private connection.

```bash
dim project pr list acme public
dim project pr create acme public --title 'Add feature' \
  --source feature/change
# Target defaults to the repository's managed default branch.
dim project pr show acme public PR_ID
dim project pr edit acme public PR_ID --body 'Updated description'
dim project pr comment acme public PR_ID --body 'Explain this line' \
  --path src/index.ts --side head --line 12
dim project pr refresh acme public PR_ID
dim project pr review acme public PR_ID
dim project pr diff acme public PR_ID --json
dim project pr blame acme public PR_ID --path src/index.ts --side head --line 12
dim project pr approve acme public PR_ID
dim project pr revoke acme public PR_ID
dim project pr merge acme public PR_ID
dim project pr close acme public PR_ID
dim project pr reopen acme public PR_ID
```

Mutation commands read the current version before writing; `--expected-version`
can instead require an earlier read version. Line comments default to the current
immutable revision; `--revision` selects an older revision explicitly. General
comments omit `--path`, `--side` and `--line`. Comments require the separate Git
discussions plugin. `review` prepares exact review evidence and never approves or
promotes it. After a new push, `refresh` records a new revision; previous comments
retain their original anchors. All commands accept `--json` for agent use.

Ordinary branch/tag source refs are not workspace identity claims. Legacy
proposal refs retain their separate owner/fast-forward restrictions. New
workspace checkouts use `push.default=current`; create a feature branch rather
than pushing directly to managed `main` or `development`. Existing checkout Git
configuration and sessions are not rewritten.

`project diff` and `project blame` inspect exact immutable commits without a PR.
`project review list|resolve|inspect|approve|revoke|promote` exposes the exact
review workflow directly. `project repository merge --source BRANCH --target
BRANCH` prepares a managed branch merge through review/CI. PR decision commands
accept `--expected-version` and `--revision` fences for previously inspected
evidence. Merge never approves on the operator's behalf and requires the private
promoter role; publish remains a separate Git-sync operation.

Review inspection includes required DIM CI state and job evidence. Missing policy
is explicitly absent, not a green gate. Human approval and external GitHub status
do not satisfy required DIM CI. Repository access/source/policy remain rechecked
by their authoritative services on each operation. The host reloads local
repository selection without repeating unrelated workspace-readiness proofs
before review/sync calls; catalog availability and workspace acquisition retain
their explicit live readiness checks. See the
[complete capability and ownership map](../../../../docs/guides/git-capabilities.md).

When an operator imports a review-enabled repository without review declarations,
the plugin uses the controller's connected reviewer to protect `.dim/` changes.
Local, public URL and manifest imports share this default; explicit review
policies and entirely review-disabled imports do not require a reviewer
connection or acquire implicit review plugins. Manifest preview shows the policy
that import will persist. Required CI is declared separately and remains unchanged.
