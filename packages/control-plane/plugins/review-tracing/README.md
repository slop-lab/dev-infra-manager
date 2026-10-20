# Tracked project review rules

`@slop-lab/dim-control-plane-plugin-review-tracing` connects the shared review
tracing engine to code review. Install it with `git-repositories`, `code-review`
and a language runtime plugin such as `review-tracing-node`. No host core is
required on the control plane.

The plugin has an empty configuration. It contributes the `tracked-project`
change matcher; a trusted imported review policy selects its entrypoint and
runtime:

```json
{
  "matcher": "tracked-project",
  "options": { "entrypoint": "review/check.mjs", "runtime": "node" },
  "reviewerIds": ["security"]
}
```

The matcher discovers runtime extensions of kind `dim.review-tracing.runtime`.
Runtime code and shared broker semantics contribute to its reviewed revision.
It reads exact protected and candidate Git objects, without checking out or
mounting the repository. Dependency manifests and predicate decisions form an
opaque evidence digest attached to the exact review identity. Evidence is
recomputed during review creation, freshness checks and promotion; retaining the
same required reviewers does not make changed evidence reusable.

See the shared [review tracing design](../../../review-tracing/README.md) for
read roles, conditional dependencies, execution bounds and runtime obligations.
