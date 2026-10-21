# Native Git Web plugin

`@slop-lab/dim-web-plugin-native-git` owns controller/project/repository navigation,
review evidence and patches, proposal resolution, approval/revocation, protected
promotion and upstream synchronization. Shared typed operations and private role
connections belong to `@slop-lab/dim-native-git-client`.

With this plugin installed, ordinary Web controller configuration is sufficient.
The plugin asks each configured controller for its current managed projects,
ready repositories and available operations through the fixed `dim project console`
bridge. No private connection paths, service credentials or executables reach the
browser. Adding projects or repositories appears on **Refresh projects**; one
unavailable controller does not disable other controllers.

Controllers with dedicated registrar and importer connections also expose **New
project** and **Import repository**. Create a project, then import a public HTTPS
Git URL; an optional branch overrides the remote default branch. Import additional
repositories through the same form. The first repository becomes the default
checkout. Source acquisition is bounded, rejects credentials/private addresses,
and does not execute or automatically trust repository `.dim` code or policy.
These operations require Web `operator` authority and remain unavailable for a
direct reviewer-service connection.

Creation/import receipts are retained if the following catalog read fails;
accepted operations cannot accidentally be resubmitted by the same unchanged
form. Refresh projects to inspect current state after a read failure.

The UI selects controller, project and repository independently. Proposal drafts
are retained separately for each scope; switching scope clears evidence and fences
late responses. Read-only accounts can inspect reviews; `reviewer` authority is
required for resolve/approve/revoke, and `operator` for promotion/synchronization.
The controller and underlying service still enforce catalog scope and protection
policies for every invocation.

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
