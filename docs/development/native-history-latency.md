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

- Existing durable intent records are the authoritative outbox. Startup/explicit
  audits validate private metadata, schemas, filenames and exact event provenance.
  Owner writes maintain bounded generation/service/destination/state buckets and
  verified order metadata under the intent queue. Warm polling neither sorts nor
  rereads all retained history; selected canonical intents are reread before
  delivery. Private directory inode/version checks are authoritative; filesystem
  notifications are not required for validity. No current work means no historical review/plan
  materialization. Direct unprimed module use can resolve the active set once;
  production startup and owner publication prime the ordered catalog.
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

The core checkpoint excludes broad payload-LRU/caller migration and worker
parsing. Subsequent adapter commits remove only duplicate validation journeys:
readiness directly attests the current configured generation and issuer host in
one authenticated POST, reducing broker CP calls from four to three; it still
obtains a fresh lease and serves Git through live authority checks. Automatic
Web invokes a ready selected host without an additional full describe. Host
invocation reloads current scope and attests private service roles itself; Web
joins any in-flight refresh and retains the pinned generation. Explicit private
Web service connections remain direct, with no host credential forwarding.

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

Before measurement, the reader independently checks the actual review/plan file
counts, private single-link metadata, byte totals, largest record, job count and
the original ordered content fingerprint. An unchanged descriptor cannot conceal
a same-length file mutation. These verification reads occur before phase CPU,
event-loop and body-read counters start, in both source-tree comparisons.

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

The final source run on 2026-10-28 used the same verified corpus fingerprint and
controls above. Five warm samples per phase are descriptive, not a production
SLO; p95 is the largest of those five observations.

| Measurement | ff4 baseline above | Current source |
| --- | ---: | ---: |
| Idle warm p50 / p95 | 5341.473 / 5421.516 ms | 38.149 / 46.764 ms |
| Active warm p50 / p95 | 5338.128 / 5430.556 ms | 38.698 / 39.421 ms |
| Idle cold lookup | 5603.344 ms | 54.060 ms |
| Active cold lookup | 5336.065 ms | 88.387 ms |
| Idle main-thread body reads | 4,612,799,730 bytes | 0 bytes |
| Active main-thread body reads | 4,612,803,348 bytes | 7,589,645 bytes |
| Idle phase user / system CPU | 19546.093 / 16008.361 ms | 192.424 / 69.627 ms |
| Active phase user / system CPU | 19335.759 / 15946.705 ms | 239.965 / 74.493 ms |
| Idle event-loop maximum delay | 1312.817 ms | 11.354 ms |
| Active event-loop maximum delay | 1330.643 ms | 25.002 ms |
| Idle unrelated identity maximum | 1313.601 ms | 13.065 ms |
| Active unrelated identity maximum | 1355.033 ms | 7.317 ms |

Current identity requests were 62 per phase, with no failures. Targeted tests and
source tracing establish exact selected review/plan verification rather than a
full-history loop. The byte counter measures actual main-thread `readFile`
return bytes but does not attribute them to paths: the active warm total was
3,015 bytes, consistent with the small canonical intent rereads. It does not by
itself prove exclusive file-level attribution.
This measures the lookup surface, not complete service startup: startup still
audits historical bodies and attached plans. The table measures the core lookup,
not the subsequent broker/Web adapter changes. No installed
after-result is claimed; exact CI, deployment and installed confirmation remain
operator-owned.

Other full-payload consumers remain explicit bottlenecks outside the idle
dispatcher: reviewer list/detail/resolution, protected-update review matching,
and the optional generic review-created webhook source. In particular, enabling
that webhook source still materializes canonical review history during its own
five-second scan. This checkpoint does not claim every historical-review surface
is incremental or that the broker's remaining three round trips are free.

Validation includes the review/Git-CI suites, all 87 CLI tests, 12 host-command
tests, and five installed-execution fixture scenarios including live-owner
revocation after warm candidate access. All 63 workspace checks, tool checks and
recursive package builds passed. The full unit run under subprocess umask 0022
passed 1,898 tests, with eight skips and 20 failures: 19 failures were the
unchanged control-plane setup fixture cleanup calling absent `/usr/bin/chmod`;
one Web assertion still required duplicate discovery and was updated to require
two descriptions, one delegated operation and the same pinned generation. Its
subsequent focused run passed all 39 Web/source tests. A previous umask-0077 run
also made explicit public-permission fixtures private; those affected 15 tests
pass under subprocess umask 0022. No host files were changed to conceal these
limitations. LSP cannot
address this isolated worktree from the session's `/workspace/main` request
root; the strict recursive TypeScript checks cover the changed source instead.

The adapter regressions passed all 251 active Native Git host tests (two existing
skips) and all 24 Web plugin tests. The Web/host integration executes
the actual host console and Git service, proves two delegated reads need only
the initial presentation description, then replaces the private fixture reviewer
credential and observes HTTP 401 without rediscovery. Eleven readiness cases
exercise one authenticated HTTP request and reject mismatched host, service,
generation, Project/repository, ref, object, policy and extra response fields.

The full scenario gate passed 447 tests, with 19 skips and 89 failures in 15
unchanged harness files. This guest lacks `/usr/bin/bash`, `/usr/bin/stat` and
`/usr/bin/chmod`, its `tar` is BusyBox rather than GNU, and source-gate/bootstrap
fixtures require a disposable root/tool environment. Checkout executable-mode
assumptions also differ under the original private umask. Both nested-Docker
diagnostic failures (terminated-lane status and executable bits) reproduce in the
untouched ff4 archive. The affected harness scripts/tests and admin cleanup are
unchanged from ff4. Consequently the complete normal Ubuntu CI gate is **not**
claimed green here; the operator must run exact-commit CI before deployment.

Measurement cleanup is bounded to the fixture-owned temporary service state and
`repository/dim-git-ci-deliveries`; canonical reviews, plans and the descriptor
remain for the comparison run. Remove the persistent corpus only when both runs
are complete:

```bash
rm -rf "$CORPUS_DIRECTORY"
```

## Retained-intent history load

The additional `measure-intents` mode uses the same canonical corpus and adds
10,000 valid completed intents referencing its canonical CI event, with distinct
old generations and mixed historical service/destination bindings. It retains
them across idle and active phases, then removes only the transient fixture
delivery directory. This is synthetic history, not new execution authority.
The report separates cold and warm body-read bytes so one-time catalog loading
cannot be confused with per-tick history reads. Seeding now independently reads
the actual private records back, validates schema/filename identity, checks count
and byte totals, and verifies an ordered content fingerprint. The same descriptor
is checked again after the measured phases, excluding only the exact newly added
active intent name, and is emitted in the report before transient cleanup.
Seeding, descriptor checks and explicit intent publication are outside phase
timers; this remains a polling benchmark, not an acceptance-write benchmark.

```bash
pnpm --dir tests exec tsx --conditions=dim-source \
  scenarios/latency/native-history-cli.ts measure-intents \
  /absolute/path/to/source "$CORPUS_DIRECTORY"
```

The verified ff4 baseline with that load observed idle warm p50/p95
6184.216/6375.365 ms and active 6331.021/6520.815 ms. Five warm reads consumed
3,876,777,560 bytes idle and 3,876,780,575 bytes active; unrelated identity
requests had maxima 1541.406 and 1386.563 ms, with no failures. The independently
verified retained-intent descriptor has 10,000 records, 6,555,557 bytes and
fingerprint `sha256:417db6125393e3d44a4dd534b63bc3ad86d1c1b9d974cae86730d8f2c3f33a95`.
Raw JSON evidence is retained at
`/mnt/dim-tmp/opencode/opencode/native-history-intents-baseline-verified.json`.
Runs use a shared
development host, not an isolated production topology or a latency SLO.

The corrected indexed source with the same verified 10,000-intent fingerprint
observed idle warm p50/p95 35.812/36.648 ms and active 48.349/57.215 ms. The cold idle catalog load took
1074.232 ms and observed 6,555,557 total main-thread read bytes; five warm idle lookups read
zero body bytes. Active cold lookup took 262.892 ms; five warm lookups read
3,015 bytes total. These counters are path-unattributed; do not infer exclusive
intent-file attribution from their totals.
The same retained descriptor was verified before and after both runs and is
emitted in each raw report. The corrected report is retained at
`/mnt/dim-tmp/opencode/opencode/native-history-intents-current-final.json`;
the zero-retained-intent report is `native-history-current-final.json` alongside it.
Identity maxima were 14.158 ms idle and 7.857 ms active, with 72/64 requests and
zero failures. Event-loop maxima were 14.049/23.806 ms. The CLI happy path exited
zero in tmux; help rendered the modes, and invalid input returned bounded JSON
diagnostics with exit one.
