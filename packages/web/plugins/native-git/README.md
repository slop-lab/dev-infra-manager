# Native Git Web plugin

`@slop-lab/dim-web-plugin-native-git` owns controller/project/repository navigation,
review evidence and patches, proposal resolution, approval/revocation, protected
promotion and upstream synchronization. Shared typed operations and private role
connections belong to `@slop-lab/dim-service-client-native-git`.

With this plugin installed, ordinary Web controller configuration is sufficient.
The plugin asks each configured controller for its current managed projects,
ready repositories and available operations through the fixed `dim project console`
bridge. No private connection paths, service credentials or executables reach the
browser. Adding projects or repositories appears on **Refresh projects**; one
unavailable controller does not disable other controllers.

Newly connected controllers can discover accessible existing Projects and
explicitly attach them with configuration and default working repository choices.
Discovery reads the authenticated Git service; attachment saves only this host's
selection after fresh authority checks. It needs no registrar/importer role and
does not import source, change policy or move refs. Existing local selections
are preserved rather than silently replaced. Attachment requires Web `operator`
authority and an automatic controller connection; direct reviewer connections do
not gain host configuration authority. After attachment, the ordinary selector
and managed workspace creation draft use the attached Project.

Controllers with dedicated registrar and importer connections also expose **New
project** and **Import repository**. Create a project, then import a public HTTPS
Git URL; an optional branch overrides the remote default branch. Import additional
repositories through the same form. The first repository becomes the default
checkout. Source acquisition is bounded, rejects credentials/private addresses,
and does not execute or automatically trust repository `.dim` code or policy.
These operations require Web `operator` authority and remain unavailable for a
direct reviewer-service connection.

Automatically connected controllers also expose **Attach existing project** for
Projects already owned by the selected host authority but not present in its local
catalog. Discovery and repository inspection are read-only. The operator explicitly
selects both the configuration repository and default working repository before
attachment; an optional local name never replaces a collision. Attachment reuses
authoritative import evidence without fetching or reimporting source, then refreshes
the normal Project and repository selectors so managed workspace creation continues
through the existing flow. Direct reviewer connections omit this host-authorized
operation. Refreshes and failures keep the selected Project, defaults and local name.

Creation/import receipts are retained if the following catalog read fails;
accepted operations cannot accidentally be resubmitted by the same unchanged
form. Refresh projects to inspect current state after a read failure.

The UI selects controller, project and repository independently. Proposal drafts
are retained separately for each scope; switching scope clears evidence and fences
late responses. Read-only accounts can inspect reviews; `reviewer` authority is
required for resolve/approve/revoke, and `operator` for promotion/synchronization.
The controller and underlying service still enforce catalog scope and protection
policies for every invocation.

PR sources can be ordinary branches or commit tags, not only legacy workspace
proposal refs. Direct immutable diff/blame inspection remains usable without an
open PR. Prepare review, approve/revoke and merge are explicit separate actions.
Operator-only merge can prepare policy/CI evidence for a zero-human-review
change, but never auto-approves. Raw review and PR inspection both show the
actual required DIM CI state/jobs; missing policy is plainly absent and a human
approval is not a green CI check. Rejected preparation/admission keeps evidence
and drafts available for inspection and recovery.

The browser workflow checks ordinary source rewrites, old discussion/stale
approval, multi-repository isolation and protected-head publication to a
disposable upstream. See the [capability map](../../../../docs/guides/git-capabilities.md)
and [CI enrollment/diagnostics](../../../../docs/guides/ci-runners.md) for the
complete role and setup boundaries.

The selected controller and repository target remain visible beside capability
guidance. The panel distinguishes review-only inspection, reviewer decisions,
upstream operator actions and promoter-backed protected promotion without claiming
that a visible control grants authority. Missing sync or promoter connections are
explained instead of silently turning the workflow into an incomplete set of actions.
Automatically discovered repositories retain their configured host provenance.
They can prefill an exact managed workspace draft or open that repository's
execution jobs. Incoming repository and review links must name the same controller,
Project and repository currently present in the live catalog; invalid or stale
targets are reported unavailable without selecting another controller. Direct
review-service connections do not infer a host identity and therefore omit these
cross-feature actions.

Within the selected repository, review search matches the proposal ref,
protected ref and review ID, while the state filter distinguishes pending,
approved, revoked and stale reviews. Filtering the list does not discard the
currently opened exact evidence, patch or approval actions. Scope changes still
clear that evidence immediately, and late list or detail responses cannot populate
a newer controller, project or repository selection.

An explicit manual connection overrides automatic controller discovery:

```json
{
  "reviewerConnection":"/absolute/reviewer.json",
  "promoterConnection":"/absolute/promoter.json",
  "syncConnection":"/absolute/git-sync.json",
  "projects":[
    {"projectId":"project-a","name":"Project A","repositoryIds":["public","private"]},
    {"projectId":"project-b","repositoryIds":["public"]}
  ]
}
```

Connection files must be caller-owned mode-0600 regular files. Promoter and sync
connections are optional; the SDK attests each serving identity and verifies the
same endpoint/generation before exposing their operations. Manual mode exposes a
single **Direct connection** controller with the explicit project scope above.
Upstream merging creates a proposal and does not bypass protected review.
When a merge returns a proposal ref, **Review upstream proposal** resolves that
exact ref through the existing reviewer operation and opens its evidence. The merge
request itself performs no review decision or protected-ref update. Resolution
failures keep the returned proposal and action available for retry, while changing
controller, Project or repository removes the old action and fences late results.

**Import .dim/repos.yml** accepts pasted YAML or a local file selected in the
browser. Preview first: it shows every repository URL/branch, protected ref,
configuration repository, default checkout and the complete policy/configuration.
The subsequent import explicitly accepts that manifest configuration; the ordinary
single-URL form continues to ignore a remote repository's manifest. Neither flow
executes repository scripts. Edits invalidate the preview, drafts remain scoped to
the selected controller/project, and an unchanged accepted import stays locked if
the catalog refresh fails. Retry the same manifest after a partial import to
resume completed repositories safely.
