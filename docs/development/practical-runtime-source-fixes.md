# Focused successor: recovery ownership and installed example artifacts

Reviewed base: `6546fd0d35251a33334625b1feace94b20f484fa`, tree
`c2a31733fc02f86731f25c4791ebaa0af0d6b24d`. The successor is isolated from the
previous clean candidate and all other worktrees. The coordinator's reported
6-file/47-test real-host result applies to that base, not these new fixes.

## Recovery publication ownership

The initial regression reproduced same-token endpoint and JSON metadata edits
being overwritten after a real guest endpoint write reported failure. A second
timing case edits the file when rollback's write command begins, rather than
before its earlier host-side snapshot. The prior normal-restoration and changed-
token regressions remain present.

Rollback now carries the exact expected publication bytes for recovery and
provisional attachment delivery. The guest compares that state at restoration,
retains UUID/token/private-file validation, anchors directories beneath HOME,
and rechecks the destination before publishing the saved snapshot. Unexpected
state fails closed and is reported through the existing incomplete-rollback
aggregate. No new principal, credential rotation, migration or retry is added.

## Installed example artifact selection

Both installed role launchers use one selector for the explicit reviewed bundle.
It validates the complete matching manifest dependency graph, exact versions,
regular artifact paths and installer archive identity before npm. Recipe
installation resolves only exact same-base local build coordinates; unrelated
base versions, floating pins and non-source local variants remain rejected.
This repairs the installed entrypoint, not only the direct VM recipe.

The initial shell-entrypoint regressions rejected both valid local candidates
and exposed missing manifest/closure/archive checks. Fixed executable tests
cover host and separate control-plane launchers. Their npm stand-in stops at
the installation boundary; these source checks do not qualify a VM journey.

## Evidence and reproduction

Private first-failure and fixed-after logs are retained under
`/home/dim/tasks/dim-practical-runtime-20261106/source-fixes-*`.

```sh
pnpm --filter @slop-lab/dim-host-plugin-llm-router... --filter @slop-lab/dim-control-plane-plugin-llm-router... run build
pnpm --dir tests exec vitest run scenarios/llm-router --no-file-parallelism
pnpm --dir tests exec vitest run scenarios/harness/installedExamplesBundle.test.ts scenarios/harness/exampleRecipes.test.ts --no-file-parallelism
pnpm workspace:check
```

The owner suite passed 148 tests across 16 files; the final focused recovery
selection passed 8 cases including exact-state, changed-token and ancestor-
redirection boundaries. Installed bundle/recipe checks passed 19 tests across
2 files. The full strict workspace check passed all 76 checked projects. LSP
cannot access the external worktree; strict compiler checks are the replacement.
Exact candidate/artifact hashes and any later live harness results belong in
the private handoff, with their actual source identity. No production fleet
restart, protected merge or public push is part of this successor.
