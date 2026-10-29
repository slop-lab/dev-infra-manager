# Independent GS checkpoint verification

Production source reviewed and tested at
`4e33ad3df991b4cdb0ea9c2568c878e3ceb612fd`, based on the separate P1 checkpoint
`79dc2b64daf45f1ce5c6d400b1aaf5bfe3c9d460`. Subsequent commits correct only the
example test fixture's plugin startup/cleanup lifecycle and record this evidence.
They do not change the reviewed GS production tree.

## Reproducible gates

From the P2 checkout, Node 24.22.1 and pnpm 10.13.1:

```sh
pnpm install --offline --frozen-lockfile --ignore-scripts
pnpm --recursive --workspace-concurrency=2 run build
pnpm run check:tools
pnpm --recursive --workspace-concurrency=2 run check
```

The frozen install, all 76 workspace package builds, all recursive strict
checks including the tests workspace, and the tooling check passed. LSP requests
cannot target this sibling worktree from the agent's `/workspace/main` request
root; compiler checks are the recorded substitute, not a claim of clean LSP.

The available unit gate used ordinary permission-fixture semantics and excluded
one unchanged fixture whose cleanup executable is absent in this guest:

```sh
umask 0022
pnpm --dir tests exec vitest run \
  host control-plane contracts installer web gs git-review-tracing git-tools cli/host \
  --exclude 'scenarios/**' \
  --exclude 'control-plane/admin/controlPlaneSetup.test.ts' --maxWorkers=2
```

Result: **1,999 passed, 8 skipped; 392 files passed, 3 skipped**. The excluded
fixture contains 19 cases whose unchanged cleanup invokes missing
`/usr/bin/chmod`. No test or production guard was weakened to hide those errors.

Additional gates:

| Surface | Result |
| --- | --- |
| `pnpm --dir tests run test:cli` | 87 passed |
| `pnpm --dir tests run test:host-commands` | 12 passed |
| Execution/selected-host scenarios plus source-export scenario | 86 passed, 3 skipped |
| Final independent QA, GS non-build suite | 78 passed |
| Final independent QA, authority/CI delta | 22 passed |
| Final independent code-review runtime checks | 30 passed |
| P1 outbox quota/index/integrity/recovery regression lane | 49 passed |
| Local package packing | Completed with closed internal dependencies |

The scenario command is:

```sh
pnpm --dir tests exec vitest run scenarios/execution scenarios/selected-host \
  scenarios/harness/sourceExports.test.ts --maxWorkers=2
```

The checked-in public/private example fixture now starts prepared plugins before
attaching repository features, as production does, and owns their cleanup.
This retains the actual compiler-revision fence rather than substituting a
placeholder revision or relaxing startup checks.

## Public runtime and review evidence

Direct real-Git drivers, not only type checks, observed:

- Standalone protected promotion at sequence 1, exact retry as `already-current`,
  preserved incarnation, advanced owner epoch and an exact finalized receipt.
- Neutral review identity, pending/approval/revocation, post-CAS interruption,
  exact restart receipt reconciliation and fail-closed missing providers.
- Provider-neutral CI delivery without a DIM profile, missing evidence/provider
  denial, drained outbox and healthy restart with the exact protected candidate.
- Optional diff/blame without review/PR; PR lifecycle and discussions without
  review; sync without CI/review; exact non-default-branch PR binding.

Fresh goal, hands-on QA, code-correctness, defensive permission/integrity and
contract/artifact reviewers all returned **PASS** for the final production
checkpoint. Earlier findings were fixed before that review: borrowed admission
now revokes before draining, schema 2 attests canonical constraints/indexes,
compiler identity participates in plan proof, old accepted DIM merge rows recover
from format 12, and closed dispatcher owners release verified catalog capacity.

## Standalone artifact and provenance

The exact committed GS export contains **239 source files and 23 manifests**
(22 product packages plus the private workspace root). Its dependency graph
closes without DIM implementation, type, configuration or build dependencies.
The exported source installed offline, then installed frozen, built and passed
strict checks outside DIM. A public driver loaded the exported compiled packages
and completed real durable promotion, retry and restart.

The companion bundle verified complete, unchanged original ancestry. A clone
from that offline bundle recovered the original P1 Git-CI catalog source at
`79dc2b64`; no filtered or invented history replaced it. Export manifests record
the selected commit, trees, every original/export path, blob/mode/content digest,
dependency edge and bundle digest. See [export instructions](gs-source-export.md).

## Limits and operator gates

This is not a claim that normal exact-commit DIM CI is wholly green. An earlier
full scenario run reported 447 passed, 89 failed and 19 skipped, with the same
guest harness/tool limitations recorded in P1: missing `/usr/bin/bash`,
`/usr/bin/stat` and `/usr/bin/chmod`, BusyBox rather than GNU tar, privileged-root
requirements and executable-mode assumptions. The affected execution/host
scenarios were rerun separately as described above.

No operator credentials, service configuration, installed artifacts, live
deployment, protected merge, external forge or npm publication were used or
changed. Exact-commit normal CI, deployment and installed-environment acceptance
remain operator gates. The original Codyssey exit-128 cause remains unknown.
Prior worktree HEADs and index hashes were preserved.
