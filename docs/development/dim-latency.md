# Git, CLI and Web latency work

## Baseline and scope

Work is isolated on `feat/dim-latency`, based on
`58b72e3796459b3b84950529df292a71f023b7cc`. The frozen GS candidate and
other worktrees are not deployment targets of this work. No runtime reinstall,
deployment, firewall changes or protected-ref updates are authorized.

Guest baseline: Linux, Node v24.22.1, pnpm 10.13.1. The recursive package build
passed before source changes. Node startup measured 33.02 ms cold and, across
20 warm samples, 30.06–34.11 ms (p50 32.48 ms, p95 34.11 ms).

Read-only `git ls-remote origin HEAD` against the existing guest broker measured
28501.94 ms cold and 24024.72, 27084.27, 27052.66 ms warm (p50 27052.66 ms,
p95 27084.27 ms). Compilation was concurrent. These are installed end-to-end
broker/service measurements, not isolated fsck timings. Source fixture timings
must be reported separately: source changes do not update installed services.
The guest has no installed DIM CLI or supplied operator SSH contexts, so live
local/remote CLI comparisons cannot be claimed from this environment.

## Implementation ownership

- Repository hosting owns per-repository mutation ordering and a separate
  exclusive lifecycle/sweep fence. Reads retain live authority validation and
  bounded admission, without waiting behind unrelated writes.
- Git review owns durable accepted-proposal preparation, restart recovery and
  truthful pending/failure visibility. Git success waits for durable handoff,
  not slow review/CI preparation. Protected merge still needs exact passing
  evidence and human authority.
- Import owns bounded archive/bundle input integrity. Ordinary proof reads retain
  live authority, root/static ownership/path and selected-object checks, without
  full-bundle rehashing, whole-repository fsck or recursive object inventories.
- Installer/CLI/host adapters own lazy startup and selected command dispatch.
  Frozen CLI–host version-1 fixtures and incompatibility failures remain intact.
- Web owns private connection/catalog reads and in-flight request coalescing.
  Retained catalog metadata is presentation only; every selected operation gets
  fresh scope/generation attestation, with no completed authorization cache.

Mutations of one repository share a lane keyed by project and repository, not
branch. Lifecycle/sweep operations wait for all previously submitted mutations;
later mutations wait for that fence. Scheduler callbacks are non-reentrant:
already-locked helpers do not acquire another lane or lifecycle fence. Read
results require current authorization/snapshot checks after expensive I/O.
Shutdown rejects new work, closes admission, drains accepted work and only then
releases extension resources and durable stores.

## Verification targets

Use real disposable Git/HTTP and command fixtures to distinguish Git transport,
durable preparation, proof/hash work, queue wait and process startup. Demonstrate
slow downstream preparation does not hold the push response, failed preparation
cannot grant merge, restart recovery is truthful, independent repositories and
reads progress, tampering/authority changes are rejected, and capability/version
failures remain explicit. Record cold/warm p50/p95 where repeated timings are
meaningful; do not infer remote installation performance from local fixtures.

## Reproducible before/after Git and proof measurements

`tests/scenarios/latency/measure-native-git.ts` drives real disposable Git/HTTP
services. The baseline is an untouched source archive of exact `58b72e37`, with
its own offline frozen-lockfile install and built GS packages, not workspace
dependency links back into the changed tree. The same driver imports each tree's
fixture and production owners. No installed service is updated.

Run from `tests/`, supplying the baseline archive or feature source tree:

```bash
pnpm exec tsx --conditions=dim-source scenarios/latency/measure-native-git.ts SOURCE_TREE proof
pnpm exec tsx --conditions=dim-source scenarios/latency/measure-native-git.ts SOURCE_TREE git
```

Linux, Node v24.22.1, loopback HTTP, tiny repository. Each proof row contains one
cold and ten warm samples. Git rows contain one cold and five warm samples.
The comparison runs shared the guest with independent reviewer processes, so
small differences are noise, not network or large-repository promises.

| Surface | Baseline cold | Baseline warm p50/p95 | Feature cold | Feature warm p50/p95 |
| --- | ---: | ---: | ---: | ---: |
| Imported-root proof HTTP | 44.72 ms | 39.40 / 43.49 ms | 56.06 ms | 33.12 / 36.64 ms |
| Proposal push, deliberately 1,000 ms CI `prepare()` | 1448.31 ms | 1431.48 / 1460.15 ms | 165.88 ms | 189.51 / 218.13 ms |
| Ordinary unprotected branch push | 158.77 ms | 145.00 / 153.11 ms | 136.95 ms | 151.31 / 153.33 ms |
| Workspace writer `git ls-remote origin HEAD` | 120.51 ms | 118.50 / 131.40 ms | 116.63 ms | 137.28 / 143.26 ms |

The substantial result is removal of downstream preparation from proposal push
latency, not a claim that ordinary refs previously ran CI. Ordinary push and
discovery did not show a warm-median improvement in this small fixture. Cheap
live checks, filesystem metadata walks and Git process startup remain costs;
the small sample does not support claims of universal speedup.
These historical proof rows used a now-removed whole-store attestation model;
they are not current-policy qualification. The driver waits for the exact
raw job to become `ready` before advancing to the next sample, so it does not
hide preparation by superseding earlier work. The installed broker's roughly
27-second read-only baseline remains a separate topology and is not claimed
fixed without operator deployment and exact-commit verification.

## Selected-object integrity boundary

Routine import, startup, proof/read, review, candidate acquisition and source
export do not run a whole-repository integrity check. The service no longer
maintains the whole-store attestation cache or recursive object metadata
snapshot. Ordinary reads do not hash the full retained bundle. Service-owned
trusted storage instead retains private root/ancestor and static path ownership
gates, exact authority/ref/target checks and bounded selected-object validation.

First import still verifies declared bundle/archive bytes, size, SHA-256 and safe
extraction. Incremental Git received-object checks remain enabled. Corrupt
selected commit/tree/blob data fails without automatic repair. No unrelated
object-store or retained-bundle tamper detection is claimed on ordinary reads.
The normative boundary is in
[Native Git transport](../specs/local-details/native-git-transport.md).

Use the real disposable first-import/read, worker acquisition/export and GS
review regressions to verify this behavior; do not substitute a new full-scan
command or another recursive object inventory. Whole-store inspection remains
an explicit operator choice, not a new DIM check CLI or normal-path prerequisite.

This is a user-requested integrity-policy/performance change, not evidence that
fsck caused an earlier fetch timeout. Installed-service timing and historical
network causes remain separate from source-fixture verification. Backend total
elapsed time is not an isolated Git fetch duration.

## Web Native Git catalog latency evidence

The Web change is confined to the Native Git plugin's existing automatic
controller adapter. Configured direct mode still constructs
`createNativeGitOperator` from private reviewer/promoter/sync files and invokes
the service client directly. Automatic remote/controller mode still has one DIM
CLI process hop for each actual describe or operation because the controller owns
those private role files; this work does not forward them or add a generic
connection framework.

Automatic discovery now starts independently for each configured controller.
Concurrent catalog reads share the same in-flight describe. A catalog may return
after the first controller has supplied a freshly parsed scope, operation list and
generation; an initially pending controller is explicitly unavailable. Later
refreshes retain last-known catalog metadata only for presentation, without
flapping healthy connections. Each operation joins or starts a fresh selected
controller describe, validates its scope/operation, and dispatches with that
exact attested generation. A slower
fresh result that completes after an earlier response remains observable on a
later catalog read rather than being starved by a repeatedly faster controller.

The local in-process timing driver used Node v24.22.1 and three samples with two
synthetic controllers. Both discoveries were in flight before `projects.list`;
the driver asserted that the catalog promise was still unsettled after one event
loop turn, then released only the fast controller. Thus the warm result is not a
reused completed ready catalog. For comparison, the same driver timed the former
exact `Promise.all` wait shape with a 1,000 ms slow controller:

| Sample | New `autoConnect` return | Fresh in-flight fast result to catalog | Former all-controller wait shape |
| --- | ---: | ---: | ---: |
| 1 | 0.48 ms | 3.25 ms | 1001.42 ms |
| 2 | 0.07 ms | 0.12 ms | 1001.28 ms |
| 3 | 0.05 ms | 0.12 ms | 1000.92 ms |

The new warm p50 was 0.07 ms for `autoConnect` and 0.12 ms from releasing the
fresh fast result to receiving the catalog; the three-sample p95 values were
0.48 ms and 3.25 ms. The comparison p50/p95 were 1001.28/1001.42 ms. These are
synthetic scheduler/adapter measurements, not installed local or SSH topology
latency and not a sub-millisecond network claim.

The authenticated HTTP surface driver is
`tests/web/plugins/native-git/catalogLatency.test.ts`. It starts the real Web
server and plugin loader, signs in through `POST /v1/session`, sends the CSRF- and
cookie-authenticated `projects.list` request, and holds a real synthetic slow
controller child process behind a filesystem gate. The test proves Web startup
and the HTTP response both complete while that gate still exists, returns the
fresh fast controller with the slow one unavailable, and records exactly one
fast-controller describe. No browser asset or visual interaction changed, so
this authenticated HTTP path is the matching manual-QA surface.

Commands run from the repository root:

```sh
pnpm --dir tests exec vitest run \
  web/plugins/native-git \
  web/plugins/nativeGeneration.test.ts \
  web/plugins/multiRepositoryReview.test.ts \
  web/controllerDiscovery.test.ts
pnpm --filter @slop-lab/dim-web-plugin-native-git check
pnpm --filter @slop-lab/dim-web-plugin-native-git build
pnpm --dir tests exec tsc --noEmit
git diff --check
```

Those checks passed: seven Vitest files with 30 tests, package typecheck/build,
the tests workspace TypeScript check and whitespace validation. Direct operator
wiring remains covered by `tests/web/plugins/native-git/plugin.test.ts`: the
configured fixture observes identity attestation followed by only the requested
review service read, with no controller CLI bridge or extra catalog service call.

## CLI startup evidence

The CLI comparison used Node v24.22.1 on the same Linux guest. The baseline was
built from a detached source archive/worktree at exact commit
`58b72e3796459b3b84950529df292a71f023b7cc`; the comparison build used the
current `feat/dim-latency` source. Both sides ran the same package builds:

```bash
pnpm --dir packages/installer run build
pnpm --dir packages/cli/core run build
pnpm --dir packages/host/core run build
```

Each timing used `performance.now()` around synchronous child execution. The
first invocation after the build was recorded as cold. The remaining invocations
were sorted and reported as warm p50/p95. Standard output and standard error
were discarded during timing. The isolated commands were:

```bash
node packages/installer/dist/cli.js --version
node packages/host/core/dist/application/host-main.js --help
node packages/host/core/dist/application/host-main.js control-plane --help
```

The host commands used empty disposable `DIM_PLUGIN_HOME` and `DIM_STATE_ROOT`
paths. Each isolated row has one cold sample and 30 warm samples:

| Surface | Baseline cold | Baseline warm p50/p95 | Current cold | Current warm p50/p95 |
| --- | ---: | ---: | ---: | ---: |
| Installer-only `--version` | 106.82 ms | 103.58 / 110.18 ms | 62.95 ms | 62.08 / 71.64 ms |
| Host root `--help` | 172.83 ms | 167.39 / 183.54 ms | 161.50 ms | 153.72 / 162.52 ms |
| Selected `control-plane --help` | 163.54 ms | 154.81 / 172.50 ms | 67.54 ms | 64.70 / 71.63 ms |

The end-to-end local fixture created a private config, an executable CLI wrapper
and the configured host executable at
`$DIM_DATA_HOME/runtime/current/node_modules/.bin/dim-host`. Each wrapper used
`exec node` to enter the corresponding built package and appended one start
record before replacement. The timed command was:

```bash
DIM_CONFIG_PATH="$FIXTURE/config.json" \
DIM_DATA_HOME="$FIXTURE/data" \
DIM_STATE_ROOT="$FIXTURE/state" \
DIM_PLUGIN_HOME="$FIXTURE/plugins" \
node packages/installer/dist/cli.js ls --json
```

The state and plugin directories were empty, so this exercised facade
validation, CLI host selection, version-1 capability negotiation and the actual
host-owned list command without Docker, SSH, a controller or a daemon. One cold
sample plus 20 warm samples measured 412.46 ms cold and 399.49/417.29 ms warm
p50/p95 on the baseline, versus 356.40 ms cold and 358.72/379.47 ms warm p50/p95
on the current source.

Wrapper evidence recorded exactly one CLI start and two host starts per command
on both builds. Including the facade, the frozen flow therefore still performs
four executable starts: facade, CLI, capability host and command host. The
facade now replaces itself with the CLI, so peak live process depth falls from
three processes (facade + CLI + host) to two (CLI + host). The separate
capability host remains mandatory: CLI-host protocol v1 requires negotiation
before command execution and an incompatible host must fail before loading or
running the command. No capability, authentication or workspace-state cache was
introduced to hide that check.

Reusable source-level drivers and manual surfaces are:

- `tests/installer/cli.test.ts`: lazy installer graph, proxy environment, PID
  replacement, argv/cwd/stdio and facade behavior.
- `tests/host/core/application/commands/selectedDispatch.node.test.ts`: selected
  controller owner dispatch without workspace application imports.
- `tests/cli/cli.test.ts` and `tests/cli/hostTransport.test.ts`: frozen version-1
  negotiation, incompatible-host refusal, local/SSH invocation and streaming.
- `tests/host/core/application/cliHostProtocol.test.ts`: independent frozen-v1
  host fixture and rejection before feature execution.
- Built manual entrypoints: `packages/installer/dist/cli.js`,
  `packages/cli/core/dist/cli.js` and
  `packages/host/core/dist/application/host-main.js`.

Remaining ordinary startup costs are the required capability process, Node and
launcher startup for both host calls, Commander/workspace parser construction,
and the root-help plugin catalog load. Remote SSH transport was not available in
this guest, so these local fixture results do not claim a remote latency change.

## Native Git catalog freshness correction

The automatic Native Git adapter now separates presentation continuity from
operation authorization. Each controller retains its last successfully parsed
catalog only for `projects.list` presentation while a coalesced describe is in
flight. A successful describe atomically replaces that presentation catalog and
generation. A completed describe failure clears availability. Pending work alone
does not turn a previously healthy controller into `unavailable`, so repeated and
concurrent refreshes of two healthy controllers do not alternate their visible
availability. A catalog can still return after the first fresh controller result
while another controller is pending, using that pending controller's last
successful presentation when one exists.

No operation is authorized from that retained presentation. Every selected
operation joins the selected controller's in-flight describe or starts a new
describe when none is in flight, waits for it, then validates the freshly returned
operation descriptor and Project/repository scope before dispatch. Dispatch uses
that describe's exact generation through `--expected-generation`. Scope removal
during a held refresh therefore rejects before the controller operation runs.
Describe failure, an unknown operation/access pair, or generation mismatch clears
availability and fails closed; generation mismatch still requires reconnect. No
TTL or completed security-state cache was introduced. Direct private operator
wiring and credential ownership are unchanged.

The server-only HTTP/unit verification was:

```bash
pnpm --dir tests exec vitest run \
  web/plugins/native-git \
  web/plugins/nativeGeneration.test.ts \
  web/plugins/multiRepositoryReview.test.ts \
  web/controllerDiscovery.test.ts \
  --maxWorkers=2
pnpm --filter @slop-lab/dim-web-plugin-native-git check
pnpm --filter @slop-lab/dim-web-plugin-native-git build
pnpm --dir tests exec tsc --noEmit
```

Result: seven Vitest files passed with 31 tests. The catalog latency fixture
includes the authenticated Web HTTP request while a real synthetic controller
process is held, repeated/concurrent two-controller refreshes, and revocation of
the selected repository scope during an in-flight refresh. Package check/build
and the tests workspace TypeScript check also passed. No browser assets changed.

## Final verification and remaining limits

- The complete affected Git/control-plane run passed 102 files with 462 tests
  and two existing gated skips. This includes real Git/HTTP push, preparation,
  failure/retry, generation rollover, independent repositories, final authority,
  protected refs, shutdown, filesystem crash recovery and quota scenarios.
- The installer/Web/protocol lane passed 38 files with 342 tests and one gated
  skip; the CLI Node lane passed all 87 tests. The existing Git review and
  installer case inventories were preserved while partitioning their oversized
  test modules: 19 and 50 cases respectively.
- Recursive package and tests TypeScript checks, the tools/remaining-JavaScript
  strict check, the recursive package build and final affected-package rebuilds
  passed. LSP diagnostics cannot address this isolated worktree from the harness
  root, so repository compiler checks are the diagnostics evidence.
- Manual terminal use of the built facade and selected host returned `[]` for
  negotiated `ls --json`, rendered host help, and rejected missing/invalid input.
  A separate live Web HTTP driver observed unauthorized `401`, login `201` and
  authenticated catalog `200`, returning the fresh fast controller while the
  slow controller was still gated. An independent real Git/HTTP timing driver
  exercised both ordinary refs and the deliberately slow proposal preparation.
- Independent goal, code, security, runtime and contract reviews passed after
  finding-specific corrections. In particular, rejected reviewer resolution now
  leaves neither acceptance authority nor a canonical envelope; pending explicit
  acceptance cannot race approval. CI intent and completion-marker stores use
  short repository-owned storage operations, typed crash recovery and admission
  bounds instead of racing the asynchronous preparation worker.

One unrelated installer harness fixture remains environment-blocked:
`tests/scenarios/harness/targetInstallerSelection.test.ts` hard-codes
`/usr/bin/bash`, which does not exist in this guest (`/bin/bash` does). Its
subprocess never starts, so the fixture's invocation log is absent. The fixture
was not changed or disabled; the targeted installer/Web run explicitly excludes
that environment-dependent scenario. The Git skips require root for a foreign-UID
upload check and an explicitly selected Docker image for cross-namespace storage
ownership. These checks are not represented as installed-host acceptance.

No deployment, runtime reinstall, firewall change, protected-ref update or remote
credential use occurred. The installed broker still needs operator deployment
and independent exact-commit CI before its latency can be compared. Remaining
costs include Git process startup, recursive metadata walks, durable journal
scans/fsync, mandatory CLI-host v1 negotiation, and the automatic Web controller
bridge/fresh attestation. The existing explicitly configured private direct Web
connection remains direct; automatic mode does not forward private role files to
avoid those costs.
