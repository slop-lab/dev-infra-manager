# P1/P2 validation follow-up

This follow-up validates the combined P1/P2 source after the published
checkpoints `79dc2b64daf45f1ce5c6d400b1aaf5bfe3c9d460` and
`8781c1a91fc90b783095a5a7caf711187d0c9728`. It does not deploy DIM, mutate
control-plane configuration, publish packages, merge a protected ref or remove
an operator workspace. The ordinary follow-up branch contains only defects
found while closing local verification plus this evidence record.

## Recovered failure inventory

The earlier scenario output is retained privately at
`/home/dim/.local/share/opencode/tool-output/tool_18541999d0010PJRU2ZcE7J4ZK`.
It reported 447 passed, 89 failed and 19 skipped tests across 103 files. The
failures group as follows; repeated assertions are not independent defects.

| Category | Earlier signature | Affected tests | Required context | Resolution |
| --- | --- | --- | --- | --- |
| Alpine launcher paths | `spawnSync` status `null`; missing invocation/version logs | bootstrap Ubuntu, Git clone source, local registry/package identity/source build, project install facade, target installer, stage runner | GNU Bash/coreutils at the fixture's `/usr/bin/*` paths and ordinary fixture umask | Installed container-local GNU tools and symlinks; the complete Debian source gate passes |
| Bootstrap artifact helper | `/usr/bin/stat: No such file or directory` | `bootstrapArtifactCache.test.ts` | GNU `stat` at the reviewed absolute path | Covered by both Debian source-gate lanes |
| Source archive | `tar: unrecognized option: mode=go-w` | `sourceGateContainerBehavior.test.ts` | GNU tar | Installed GNU tar for the outer copy; both isolated lanes pass |
| Source-CI disposable root | `missing source CI tools require a disposable root container` | non-opt-in cases in `sourceCiPreflight.test.ts` | Debian root job with service-autostart denial | Covered by the complete gate; both opt-in real-container cases also pass separately |
| Nested diagnostic mode | executable mode mismatch | `nativeWorkspaceNestedDockerDiagnostic.test.ts` | source copied with reviewed executable modes | Passes in the exact source gate |
| Native Git owner image | copied removed `core/packages/native-git/...` path | opt-in `storageOwnership.test.ts` | pinned Node image and current monorepo path | Fixed to copy the owning `git-repositories` source; 6/6 pass |
| Pinned mise smoke drift | expected mandatory mirror, old help/footer, old controller/CLI paths and reconnect accounting without a post-update baseline | `mise-install-smoke.bash` | pinned mise v2026.8.4 in its disposable container | Updated to current optional-provider, selected-host help, independent CLI, and managed-controller contracts; an incomplete client must reconnect after the controller PID changes; smoke passes |
| Managed controller update | active probe used ordinary state/runtime roots and accepted controller-shaped processes, Node eval modes or units below the install tree | real mise host update with a running managed controller | managed state root, `/dim/managed` runtime identity, private unit metadata and the exact installed host entrypoint after a bounded set of non-executing Node options | Fixed PID and pre-PID systemd probes with focused tests; active update restarts and reconnects while positional, eval and unit lookalikes are rejected and DIM's source/debug launch options remain detectable |
| Guest service removal race | `ESRCH: no such process` after live identity validation, possible orphaned child, or owner metadata replaced while opening | parallel guest service cleanup | supervisor exits between identity check and signal, or atomically republishes its owner record | Retry owner publication, recheck captured boot/start identities immediately before same-user workspace signals, and terminate the recorded child after supervisor exit; deterministic regressions and complete source gates pass |

The final source-gate logs supersede the earlier aggregate failure result; no
assertion, permission guard or test selection was weakened.

## Complete source gate

The repository's exact isolated gate was run at executable-source commit
`7abc455e74ecb15c3180f568f98a375cd2c10c47` using
the checked-in wrapper and pinned Debian Bookworm images:

```sh
DIM_CHECK_LOG_DIR=/mnt/dim-tmp/opencode/opencode/validation-final-7abc-node24-quiet \
  DIM_SOURCE_NODE_MAJOR=24 bash scripts/checks/source-gate-container.bash
DIM_CHECK_LOG_DIR=/mnt/dim-tmp/opencode/opencode/validation-final-7abc-node26 \
  DIM_SOURCE_NODE_MAJOR=26 bash scripts/checks/source-gate-container.bash
```

Both lanes completed all eight stages: prerequisites, strict checks, package
build, ordinary tests, executable examples, privileged service fixtures,
package packs and production dependency audit. Each lane reported:

- unit: 2,029 passed, 5 skipped;
- CLI: 87 passed;
- host commands: 12 passed;
- scenarios: 536 passed, 19 skipped;
- privileged service fixtures: 135 passed;
- dependency audit: no known vulnerabilities.

The executable-examples stage also reports the scheduled-review recipe at four
passed and one skipped. That skip is the explicit real-Docker handler case; the
same case passed separately in the Docker-focused follow-up recorded below.

An initial Node 24 gate run concurrently with Node 26 hit the unrelated
execution-scheduler reservation-renewal timing test once (HTTP 409 instead of
200). The exact test passed 20 focused repetitions and its full file passed 10
repetitions on Node 24; the complete Node 26 gate passed concurrently, and the
complete Node 24 gate then passed when run alone. The final receipt references
that quiet complete run. No retry wrapper, timeout increase or assertion change
was made.

The source-gate container runs as disposable Debian root while ordinary
permission-sensitive checks were also exercised as the non-root `dim` user.
The source was copied into the container; no host Docker socket was mounted into
the gate and no operator credentials were used.

## Skip closure and remaining gates

The five unit skips in the root source gate are:

1. one non-root private-root cleanup case, separately passed as `dim` (17/17
   focused file);
2. one Docker Native Git owner-isolation case, separately passed after the path
   fix (6/6 focused file);
3. one KVM workspace runtime requiring a reviewed KVM image, writable `/dev/kvm`
   and probe;
4. one multi-repository Sysbox recreation requiring a reviewed workspace image;
5. one ordinary guest-integration recreation requiring a reviewed workspace image.

The nested daemon exposes only `runc` and this container has no `/dev/kvm`, so
the last three are explicit host/runtime acceptance gates, not local passes.

The 19 ordinary scenario skips reconcile exactly:

| Optional surface | Count | Follow-up result |
| --- | ---: | --- |
| Node review tracing Docker describe | 9 | passed |
| scheduled review real Docker handler | 1 | passed |
| source-CI Node 26 root container | 2 | passed |
| existing control-plane real SSH forwarding | 1 | passed |
| root-owned execution cleanup image | 1 | passed |
| selected-host network-none stdio/collision | 2 | passed |
| target installer with real mise | 1 | covered by the canonical pinned-mise smoke |
| installed host-plugin SDK | 1 | remains an installed-artifact/operator-path gate; no installed DIM was changed |
| live uninstall/reinstall | 1 | remains deliberately unrun because this pass may not remove real workspaces or update an installed DIM |

The separate Docker-focused follow-up therefore passed 14 review-tracing tests,
one SSH test, one root-cleanup test, two selected-host stdio tests, both real
source-CI container tests and the Native Git owner-isolation test. The selected
host scratch image was label-checked before removal.

The pinned mise end-to-end smoke also passed with mise v2026.8.4 after its
expectations were reconciled with optional mirror selection, host-owned help,
independent CLI updates and managed controller paths. It uses a disposable
container, local registry and temporary installation only.

## Standalone GS evidence

The final candidate must retain the P2 GS source export and public drivers. The
follow-up reruns the export dependency/history checks and durable repository,
review/merge, CI and optional-composition drivers if the final code tree changes
outside installer/test harness ownership. No fixture result is described as
installed production latency.

## Deferred design backlog

No backlog item below is implemented by this verification branch.

- **GPU ownership:** decide whether the host runtime owns device discovery,
  allocation and revocation, and what explicit workspace grant prevents a guest
  or agent from selecting arbitrary host devices.
- **Mount grants:** define source and destination identity, read-only versus
  writable authority, persistence across recreation, symlink/path containment,
  and which trusted operator action selects each mount.
- **Workspace setup:** choose between reviewed declarative `.dim` metadata and
  agent-executed instructions. Decide execution user/timing, review burden,
  idempotency, failure/retry state and discovery without granting Project code
  silent host execution.
- **Optional central Web control:** decide which operations delegate to a
  selected host and which authority, if any, belongs to a control-plane plugin.
  Ordinary DIM must remain usable without a mandatory control plane; no decision
  has been made to centralize every operation.

## Authority handoff

Passing local source gates do not constitute authoritative DIM CI, review,
protected merge, deployment or installed confirmation. Those remain root/operator
actions against the exact pushed follow-up commit.
