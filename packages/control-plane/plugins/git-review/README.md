# Git repository review plugin

`@slop-lab/dim-control-plane-plugin-git-review` adds immutable proposal reviews,
human approvals and self-revocations to the Git repositories control-plane
plugin. It starts no workspace or CI worker and does not require a workflow
compiler. Installing or configuring it does not enable protected-ref promotion;
the separately selected merge-policy plugin owns that operation.

Install with `dim installer install control-plane plugin
@slop-lab/dim-control-plane-plugin-git-review`. Select it alongside the Git
repositories plugin in the private control-plane runtime configuration. Its
configuration is `{ "humanReviewers": [{ "reviewerId": "owner", "username":
"REVIEWER_USERNAME", "password": "CANONICAL_32_BYTE_BASE64URL_TOKEN" }] }`.
Credentials must be distinct across the selected repository features.

A repository opts into review with the trusted `code-review` policy section:
`{ "requiredReviewerIds": ["owner"], "pathReviewerRules": [] }`. Required
reviewers must be configured before import or service startup. The complete
trusted policy and exact repository input snapshots are bound to human approval.
Changed policy, protected head, proposal, or dependency snapshot invalidates an
old decision. Review records never execute repository code.

Review lists check recorded evidence against current policy and matcher revisions,
repository input snapshots, protected heads and proposal commit/tree identities.
Listing does not rebuild patches or run project matchers. Opening an exact review,
approving it or promoting it performs the full evidence and requirement checks;
a list status is informational and never authorizes a decision.
Startup reconciliation ignores retained proposal refs whose candidate commit is
already contained in the selected protected head. Fresh proposal writes and
explicit review resolution remain available and retain their normal current-state
checks; the skip prevents old absorbed refs from manufacturing new review or CI
events after a restart or protected-head change.
Live proposal notifications durably stage their exact verified review and service
generation before publishing the review. Recovery finishes accepted preparations
only for a matching-generation staged action whose policy, refs, repository inputs
and preparation proofs remain current. Ordinary historical review envelopes and
prior-generation staged actions do not become new execution authority.

## Conditional security review

The operator-imported policy can add reviewers by path or by content. Conditions
only add requirements; no matcher can remove a reviewer selected by another rule.
For example:

```json
{
  "requiredReviewerIds": [],
  "pathReviewerRules": [
    { "pathPrefix": ".dim/review/", "reviewerIds": ["security"] },
    { "pathPrefix": "deploy/", "reviewerIds": ["security"] }
  ],
  "changeReviewerRules": [
    {
      "matcher": "json-field",
      "options": { "path": "runtime.json", "pointer": "/runtime/isolation" },
      "reviewerIds": ["security"]
    }
  ]
}
```

`json-field` compares an RFC6901 JSON pointer in the exact old/new Git blobs.
Object key order and unrelated fields do not count as a protected-field change;
missing and null differ. File creation/deletion/rename, executable or symlink
modes, invalid UTF8/JSON, duplicate keys, excessive nesting, unsafe or fractional
numbers, and files above 1 MiB conservatively require the selected reviewer.
JSON comments and trailing commas are not accepted. Empty pointer selects the
whole JSON value.

`./plugin-api` exports `reviewChangeMatcherExtension` and `ReviewChangeMatcher`
for custom rules. A provider validates its options and returns a boolean or
`{ matches, evidenceDigest }` over
immutable changed paths and bounded Git blobs. `readBaseFile` and `readCandidateFile` read regular
files from the exact protected and candidate commits, independent of any mutable checkout.
Provider identity includes a SHA256 revision covering its implementation and
configuration. Missing/duplicate providers, invalid options, evaluation errors
and malformed results cannot silently bypass review. Structured evidence digests
are bound into review identity and recomputed even when reviewers stay unchanged. Provider revisions and
the complete policy are bound to the review ID; creation, approval and promotion
recompute requirements. Installing a new matcher implementation invalidates an
old review even if it happens to return the same reviewers.

A matcher can live in the Project repository. Protect its entrypoint, settings
and dependency closure with an independent mandatory path rule. Changing the
matcher requires that review even if the candidate matcher returns false; it
does not have to execute an older protected version. The operator-imported rule
is the trust anchor: a candidate cannot edit it to disable its own protection.
Execute project code in an isolated evaluator rather than the credential-bearing
control-plane process. The [security review example](../../../../examples/features/security-review/README.md)
shows a single-file project matcher, bounded Docker execution, and unconditional
protection of its own review directory.

For automatic dependency protection, install the optional
[review-tracing](../git-review-tracing/README.md) and
[Node runtime](../git-review-tracing-node/README.md) plugins. Their
[executable example](../../../../examples/features/review-tracing/README.md)
uses imports and ordinary reads as dependencies, and explicit target reads for
JSON field decisions. It requires no manually maintained dependency path list.

These checks govern DIM's native protected refs. GitHub branch protection and
rulesets are a separate authority; a DIM policy does not configure them.

The Git-CI plugin can supply an optional preparation capability. Its immutable
plan digest is attached to the review; its workflow interpretation, execution
grants, evidence and delivery state remain owned by Git-CI. Without that plugin,
review creation reads no workflow files.

Use the private `reviewer.json` generated by control-plane connect:

```bash
dim-code-review resolve /absolute/path/reviewer.json PROJECT REPOSITORY PROPOSAL_REF
dim-code-review inspect /absolute/path/reviewer.json PROJECT REPOSITORY REVIEW_ID
dim-code-review approve /absolute/path/reviewer.json PROJECT REPOSITORY REVIEW_ID
dim-code-review revoke /absolute/path/reviewer.json PROJECT REPOSITORY REVIEW_ID APPROVAL_ID
```

The CLI checks file ownership, mode 0600, reviewer identity and deployment
generation before an operation. `./plugin-api` exports the typed review service
and preparation ports for separately installed trusted features.

Review-enabled branches require a valid `code-review` declaration. Import and
policy updates reject missing declarations when this plugin is enabled; resolving
an existing incomplete repository reports how to configure it instead of treating
it as approval-free. Review-disabled branches can resolve without the extension.
Explicit malformed declarations are rejected even for review-disabled targets.
