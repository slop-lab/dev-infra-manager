# Native Git historical-review latency

## Priority-1 scope and evidence

This work is isolated in `/workspace/dim-native-history-latency` on
`feat/native-history-latency`, based on approved deployed
`ff4ec121e07d351aabb717c3fb030c76ce67e63a`. Existing worktrees, indexes,
workspace identities and service configuration are not deployment targets.
Priority-2 GS implementation has a separate subsequent checkpoint.

The sanitized operator report establishes repeated historical materialization,
not object-directory walking, as the dominant seconds-scale workload. Its
140 records contain 384,445,903 bytes; one diagnostic read/parse/schema/hash/CI
projection pass took 5,714 ms. The idle dispatcher repeats that work every
1,000 ms even without pending delivery. Its CPU profile corroborates the work,
while source tracing supplies the asynchronous caller attribution. The isolated
Codyssey exit 128 remains unexplained: its original stderr was not retained.
Later successful reads are not evidence that its unknown cause was fixed.

## First-cut ownership and verification contract

- Existing durable intent records are the authoritative outbox. Strict private
  metadata/schema/filename validation precedes filtering by generation, service,
  destination and pending/due-superseded state. No current work means no historical
  review or CI-plan materialization.
- Review owns an opaque, frozen `VerifiedCiReviewSource`, obtained only after
  full canonical schema/digest validation. Its compact summary excludes changes,
  patch and patchBytes. Exact file-version checks include device, inode, size,
  nanosecond mtime/ctime, UID, mode and link count, with stable FD reads and
  post-read path agreement. Previously attested immutable-file changes fail closed.
- The ports are `readVerifiedCiReviewSources(repository, reviewId?)` and
  `assertVerifiedCiReviewSourceCurrent(repository, source)`. Startup audits may enumerate all
  sources; delivery asks only for matching review-ID variants. Proofs are
  process-issued capabilities for byte integrity, never authorization.
- Git-CI owns `readVerifiedGitCiDeliveryProjection(repository, source)`: verify
  the exact plan, attachment and snapshot, derive compact event metadata through
  existing digest domains, and retain only bounded frozen summaries/projections.
  The intent's envelope ID is the CI projection ID, not the canonical review
  filename's envelope ID. Matching variants must produce identical event bytes;
  deduplication retains the earliest createdAt.
- Delivery revalidates the selected canonical intent and exact review/plan/event
  before publishing completion or supersession. Marker publication still precedes
  intent completion. Short repository storage operations cover recovery/publication
  without holding locks over network requests.
- Complete historical review and attached-plan validation occurs at startup;
  selected records are verified on every use. Idle polling is not a full-body
  audit of unrelated inactive history. A changed unused record is detected at
  its next selection/catalog enumeration or startup, not by a one-second body scan.
- Activation, current generation, ownership, policy, refs, reviewer/issuer scope,
  decisions, execution evidence and final protected CAS remain live. There is no
  TTL, persisted cache, new daemon, unverified side index or changed digest domain.

The first checkpoint excludes broad payload-LRU/caller migration, worker parsing,
broker consolidation and Web transport changes. Those adapters are examined
separately after the dispatcher checkpoint, rather than obscuring its evidence.

## Unchanged installed own-origin sample

The read-only guest command below preserves every sample, exit status and bounded
sanitized stderr. It makes no retry, deployment, configuration change or claim
that a later successful sample fixes an earlier failure. It never records Git
response bodies, Authorization values, credential-bearing URLs or remote response
diagnostics. Five sequential samples on 2026-10-28 at 10:25 UTC were
`3171.261, 500.040, 9697.308, 510.551, 3918.880` ms: p50 3171.261 ms, p95/max
9697.308 ms, five exit-0 results and no retained stderr. This separate installed
`ff4` observation confirms a variable stall plus a roughly 500-ms floor; it is
not an installed after-result for the unreviewed source changes.

```bash
pnpm --dir tests exec tsx scenarios/latency/native-git-read-evidence.ts \
  /workspace/dim-native-history-latency 5
```

The original Codyssey failure remains unknown and was not sampled through a
different repository or unauthorized connection. Future driver failures retain
their numeric Git exit code, signal, deadline/output-bound classification and
up to 2048 bytes of redacted diagnostic evidence rather than discarding stderr.

## Reproducible historical-review benchmark appendix

`tests/scenarios/latency/native-history-cli.ts` measures the production
`readPendingAuthoritativeNativeDeliveries` path against real private filesystem
records. The corpus is synthetic storage/CPU input, not evidence that synthetic
Git commits or patches can be promoted. It contains no operator data, service
credentials, response bodies or host configuration.

Prepare the corpus once in a separate process, then reuse the same directory and
fingerprint for baseline and current source trees:

```bash
CORPUS_DIRECTORY=/mnt/dim-tmp/opencode/opencode/native-history-corpus-ff4
pnpm --dir tests exec tsx --conditions=dim-source \
  scenarios/latency/native-history-cli.ts prepare \
  /workspace/dim-native-history-latency "$CORPUS_DIRECTORY"

pnpm --dir tests exec tsx --conditions=dim-source \
  scenarios/latency/native-history-cli.ts measure \
  /absolute/path/to/ff4-baseline "$CORPUS_DIRECTORY"

pnpm --dir tests exec tsx --conditions=dim-source \
  scenarios/latency/native-history-cli.ts measure \
  /absolute/path/to/current-source "$CORPUS_DIRECTORY"
```

The prepare command uses the selected tree's production review and CI
constructors/stores. It writes 140 canonical review envelopes and 79 immutable
CI plans, one valid job per plan, with 61 reviews intentionally lacking CI. The
private mode-0600 descriptor records the exact content fingerprint, counts and
sizes. Preparation refuses an existing corpus directory, so baseline/current
comparisons cannot silently repopulate different bytes.

Each measurement is a new process. It starts an unrelated configured Native Git
fixture only for the real authenticated
`GET /v1/operator-workspace-write-issuer-identity`; the corpus repository is not
registered with that service and has no automatic dispatcher. A worker thread
keeps the 100 ms request timer and latency clock outside the server event loop,
allows at most one in-flight request and applies a 5,000 ms deadline. Response
bodies and synthetic Basic credentials are never emitted.

The idle phase has no delivery intent. The active phase adds one production-
validated explicit intent for the descriptor's canonical synthetic review. Both
phases perform one cold lookup and five warm lookups, waiting the dispatcher's
default 1,000 ms interval after each completed read without overlapping loads.
The report includes lookup p50/p95/max/count, process user/system CPU, event-loop
delay p50/p95/max, identity p50/p95/p99/max/count/failures, and main-thread
`FileHandle.readFile` return bytes. The byte counter does not claim visibility
into worker or native off-thread reads.

Baseline on Linux, Node v24.22.1, exact source
`ff4ec121e07d351aabb717c3fb030c76ce67e63a` plus these benchmark files:

```json
{
  "corpus": {
    "reviewRecordCount": 140,
    "projectionCount": 79,
    "jobCount": 79,
    "historyBytes": 384360201,
    "planBytes": 79553,
    "largestReviewBytes": 7585020,
    "corpusFingerprint": "sha256:c9767d11299b012c4faf060378ec3d99e6c95d52380b0f1b9769038d9c3a78ba"
  },
  "idle": {
    "lookup": { "coldMilliseconds": 5603.344, "warm": { "count": 5, "p50Milliseconds": 5341.473, "p95Milliseconds": 5421.516, "maxMilliseconds": 5421.516 } },
    "cpu": { "userMilliseconds": 19546.093, "systemMilliseconds": 16008.361 },
    "eventLoop": { "count": 2472, "p50Milliseconds": 12.689, "p95Milliseconds": 15.663, "maxMilliseconds": 1312.817 },
    "identity": { "count": 290, "failures": 0, "p50Milliseconds": 5.182, "p95Milliseconds": 19.798, "p99Milliseconds": 1266.533, "maxMilliseconds": 1313.601 },
    "bodyReadBytes": 4612799730
  },
  "active": {
    "lookup": { "coldMilliseconds": 5336.065, "warm": { "count": 5, "p50Milliseconds": 5338.128, "p95Milliseconds": 5430.556, "maxMilliseconds": 5430.556 } },
    "cpu": { "userMilliseconds": 19335.759, "systemMilliseconds": 15946.705 },
    "eventLoop": { "count": 2434, "p50Milliseconds": 12.517, "p95Milliseconds": 14.901, "maxMilliseconds": 1330.643 },
    "identity": { "count": 287, "failures": 0, "p50Milliseconds": 4.951, "p95Milliseconds": 12.659, "p99Milliseconds": 1270.682, "maxMilliseconds": 1355.033 },
    "bodyReadBytes": 4612803348
  }
}
```

The corpus is within 0.03% of the sanitized operator's 384,445,903 review bytes;
its largest record is 7,585,020 bytes (about 7.23 MiB). The roughly 4.61 GB observed body reads per
phase are measured main-thread reads, not a value inferred from disk size. The
fixture demonstrates storage-size scaling and shared-event-loop interference;
it does not reproduce operator topology, Git promotion, broker round trips or
installed-host acceptance.

### Current-source comparison

The final pre-review run on 2026-10-28 used the same corpus fingerprint and
controls above. Five warm samples per phase are descriptive, not a production
SLO; p95 is the largest of those five observations.

| Measurement | ff4 baseline above | Current source |
| --- | ---: | ---: |
| Idle warm p50 / p95 | 5341.473 / 5421.516 ms | 35.755 / 41.807 ms |
| Active warm p50 / p95 | 5338.128 / 5430.556 ms | 35.350 / 47.894 ms |
| Idle cold lookup | 5603.344 ms | 42.343 ms |
| Active cold lookup | 5336.065 ms | 68.811 ms |
| Idle main-thread body reads | 4,612,799,730 bytes | 0 bytes |
| Active main-thread body reads | 4,612,803,348 bytes | 7,589,645 bytes |
| Idle phase user / system CPU | 19546.093 / 16008.361 ms | 177.052 / 51.356 ms |
| Active phase user / system CPU | 19335.759 / 15946.705 ms | 191.836 / 72.598 ms |
| Idle event-loop maximum delay | 1312.817 ms | 11.035 ms |
| Active event-loop maximum delay | 1330.643 ms | 23.298 ms |
| Idle unrelated identity maximum | 1313.601 ms | 12.785 ms |
| Active unrelated identity maximum | 1355.033 ms | 9.227 ms |

Current identity requests were 61 idle and 62 active, with no failures. Active
body reads include only the selected canonical review and its plan, once;
subsequent selections verify exact file metadata without rereading patch bytes.
This measures the lookup surface, not complete service startup: startup still
audits historical bodies and attached plans. The broker's four control-plane
calls and Web discovery are unchanged by this checkpoint. No installed
after-result is claimed; exact CI, deployment and installed confirmation remain
operator-owned.

Validation on this source passed 218 review/Git-CI tests in 51 files, all 87 CLI
tests, 12 host-command tests, and five installed-execution fixture scenarios
including live-owner revocation after warm candidate access. All 63 workspace
checks, tool checks and recursive package builds passed. A prior broader unit
run encountered fixture/environment limitations: umask 0077 makes explicit
public-permission fixtures private (the affected 15 tests pass under subprocess
umask 0022), and `/usr/bin/chmod` is absent although `/bin/chmod` exists. Neither
host files nor tests were changed to conceal those limitations. LSP cannot
address this isolated worktree from the session's `/workspace/main` request
root; the strict recursive TypeScript checks cover the changed source instead.

Measurement cleanup is bounded to the fixture-owned temporary service state and
`repository/dim-git-ci-deliveries`; canonical reviews, plans and the descriptor
remain for the comparison run. Remove the persistent corpus only when both runs
are complete:

```bash
rm -rf "$CORPUS_DIRECTORY"
```
