# Private container artifact handoff candidate, 2026-11-12

## Candidate and authorization

- Branch: `work/container-artifacts-20261111`, continuing diagnostic candidate
  `c8b658c06f643d0bde600e22eb58d986cce94a27`, without rebasing other work.
- Archive decoder commit: `40dfc326`.
- Causal backend/worker integration: `b237d6cc233bbbf33fe08860fd2c0d9d0a23e21d`;
  integration tree: `58c0f3f4b80070e7617d6cb61b964c9224c01fcf`.
- Final branch-tip SHA/tree, including driver/docs/evidence commits, are in the
  handoff, avoiding a recursive self-reference here.
- Root authorized implementation only. No actual Docker/KVM runtime, install,
  service/profile change, control-plane mutation or GitHub publication was run.

## Causal evidence versus historical unknowns

The supplied `artifact-causal-20261112.json` is 1,484 bytes, SHA-256
`3766c7dba43651da237fcf98a297e8996da64b4ff91ae20c8c16f02f759a4f4f`.
It remains unchanged outside the checkout.

Operator nonce: `fffccb07-6199-4772-b225-0556b8b61166`; actual worker UID: 1000.
Guest UID/GID 0 wrote regular single-link files at modes `0600` and `0644`.
After the exact outer container was stopped/removed, both were host UID/GID 0;
the private file failed open with `EACCES`, while the readable control succeeded.
The installed capture returned unavailable with only logs despite command exit 0.
Installed `artifacts.js` SHA-256 was
`cdcf9c688dae9fd79a1e9e22390172e6afccec24a484bcd30cace3a89c1b395a`.

The operator reports the same installed launcher and pinned Docker `9e79` / nested
Node `5c40` as ordinary workers on new sub4. Full image digests are not present in
this receipt; the later runtime gate must record them. Container
`f35cd2786b7f502b8a530576e4994a6b38a3d05c432aa909062795e8c9e5c422`
is reported removed, with its private fixture/evidence root retained. No host
state was scanned or reprobed by this workspace.

This establishes a current ownership gap, not the exact historical syscall for
execution `b6572e6c-bdf1-44f5-a576-490b63389d90`. Original unavailable receipts
and process-success evidence remain distinct and immutable; see the prior
`container-artifact-capture-20261111.md` report.

## Implemented ownership boundary

1. The Sysbox adapter retains the launched CID. Before export it verifies that
   exact CID and all existing ownership labels, stops it with zero grace, and
   rechecks exited/nonrunning/nonpaused state and PID zero. Normal completion,
   failure and cancellation use the same exact-owned cleanup boundary.
2. Only fixed `root/workspace/.dim-ci-artifacts` metadata is traversed, without
   following ancestors or children that are symlinks. Regular single-link files,
   size/count/depth/path bounds and device/inode/UID/GID/mode/link/size/nanosecond
   identity snapshots are checked before and after export. This detects an
   additional hardlink outside the exported directory, which tar cannot attest.
3. Payload bytes come from `docker cp EXACT_CID:/workspace/.dim-ci-artifacts -`,
   without `-L`, before removal. The worker-owned archive uses exclusive,
   no-follow `0600` creation outside the guest workspace. Raw archive bytes,
   stderr and subprocess lifetime are bounded; stream completion/fsync precedes
   handoff. Export failure removes only the spool this attempt created.
4. The generic backend result carries a typed artifact source, not Docker
   commands or arbitrary host paths. The worker supplies/verifies a fresh nonce,
   strips source/nonce/inode data from public results and journals, then validates
   the archive before committing file metadata to the manifest. QEMU has no new
   source and keeps direct shared-file capture unchanged.
5. The decoder validates USTAR/PAX framing/checksum, canonical root, exact indexed
   entries, missing/duplicate paths, declared sizes and complete termination.
   Links, special files, sparse/unknown records and traversal are rejected. PAX
   paths/timestamps are bounded; numeric owners and exact Moby binary capability
   metadata are discarded rather than restored. Other xattrs remain rejected.
   Payloads are copied in at most 64 KiB chunks into flat hashed private files,
   not extracted by a generic tar tool. Invalid partial file sets are deleted.
6. Valid stdout/stderr survive export/validation failure. Artifact availability
   never rewrites a successful command into a failed command. Uncertain runtime
   removal still throws/fences; observers are cancelled/joined and output spool
   handles close even on that path. Lost launch responses do not claim a
   successful empty export.

No source chmod/chown, privileged helper/container, guest identity change,
credential/socket mount, policy engine or new dependency was added. Fixture-only
mode changes simulate unreadable host originals after removal; they do not
reproduce actual Sysbox UID remapping. Direct-directory metadata must be
readable/searchable by the host worker: inaccessible directories fail closed.
Supporting root-owned `0700` directories would need a different trusted metadata
capability; this candidate does not bypass that limit.

## Focused development evidence, not DIM CI

Node 24: `24.18.1`. Node 26: existing isolated musl `26.12.1` at
`/mnt/dim-tmp/opencode/opencode/node-v26.12.1-linux-x64-musl/bin/node`.
No runtime/toolchain service or profile was installed or updated in this turn.

Final focused command, from the checkout:

```bash
pnpm --dir tests exec vitest run \
  host/plugins/execution-worker/containerArtifacts.test.ts \
  host/plugins/execution-worker/artifactArchive.test.ts \
  host/plugins/execution-worker/containerArtifactWorker.test.ts \
  host/plugins/execution-worker/sysbox.test.ts \
  host/plugins/execution-worker/artifacts.test.ts \
  host/plugins/execution-worker/qemu.test.ts \
  scenarios/execution/execution.test.ts --no-file-parallelism
```

Node 26 ran the same seven files from `tests/` using the exact executable above
and `node_modules/vitest/vitest.mjs`. Both final runs exited **0: 91 passed**.
Owner `run check` and test `tsc -p tsconfig.json --noEmit` passed on Node 24;
Node 26 directly ran the same compiler with the owner/test configs, both exit 0.
`pnpm --filter @slop-lab/dim-host-plugin-execution-worker... run build` exited 0
for its ten-package closure. `git diff --check` exited 0. LSP was unavailable;
compiler checks, not invented LSP results, supply strict evidence.

Coverage includes stopped handoff ordering, exact CID/foreign labels, nonce
binding, `0600` bytes, outside-root hardlinks, ancestor/root symlinks, real FIFO,
size/count/depth bounds, source mutation, stop/running/export/stream failures,
removal fencing, malformed/duplicate/truncated/traversal/PAX archives, partial
file rollback, raw journal/report/timeout-receipt hygiene and retained timeout
bytes. Independent decoder fixtures and backend/worker integration both run.

Manual module driver on each Node version:

```bash
node --import ./tests/node_modules/tsx/dist/loader.mjs --conditions=dim-source \
  tests/host/plugins/execution-worker/containerArtifactDriver.ts
```

Both driver runs exited 0. They used a real Node subprocess and `ProcessRunner`
pipes with 4 KiB producer chunks, not an actual Docker command. Each observed
one backpressure drain, verified all three manifest entries and 200,062 private
nonce bytes after the original host file became unreadable. Archive size was
202,240 bytes and SHA-256 was identical on both versions:
`33c2acaac4e17497fa6809623b55421070a225002f9e38b04d90fe0df7119618`.
The cancellation case terminated its producer with exit 143, retained two logs,
removed the archive and completed fixture runtime cleanup. Fixture roots were
removed. This qualifies process/stream plumbing, not Moby runtime behavior.

## Failures retained

- Failing-first nonce regression: exit 1, unavailable instead of complete.
- First test strict check: exit 2, five Buffer generic inference errors in test
  fixtures. Explicit Buffer types fixed those without suppression.
- Oracle found missing Moby numeric-owner/binary-capability PAX handling; two
  new tests failed before the bounded byte-aware decoder fix. Unknown xattr
  rejection stayed covered. Local static architectural/implementation and driver
  consultations completed; this is not a root CI review/publication.
- First expanded 90-test runs on both Node versions: one failed/89 passed due
  to the upload-timeout fixture accidentally using the foreign-nonce path.
  Only the intended foreign-nonce case now tampers with its source.
- Initial real-tar drivers failed. Installed BusyBox tar emitted unsupported GNU
  headers and could not create PAX with `--format=pax`. No decoder relaxation or
  tool install followed; a bounded Node fixture producer replaced it. A Node 24
  diagnostic rerun identified the closed archive rejection before that change.
- Isolating decoder tests initially caused 18 failures/five passes on each Node:
  missing empty log spools created two known fallback files, conflicting with the
  unchanged partial-file cleanup assertion. Creating normal fixture spools fixed
  setup; the final 91-case runs above passed. No assertion was removed/weakened,
  no production timeout increased, and no failed run was presented as qualification.

The old broader-suite failures in the prior report were not rerun or erased.
The existing pre-pending-result crash boundary is unchanged: a kill before
journaling may discard an uncommitted archive during recovery, rather than
resume it. Post-journal upload recovery remains covered. The inherited oversized
worker module was not broadly refactored for this narrow fix.

Local build module hashes for later owner comparison, not proof of installation:

| Worker module | SHA-256 |
| --- | --- |
| `artifacts.js` | `469c9873e5768a1879007c85edcb27471361b4082e411520e617d174bcae217c` |
| `artifact-archive.js` | `6c009b3a42667b11e49b395e5e9c85c1ae4a81fcab418ecf7cc27b4604139f54` |
| `artifact-source.js` | `780695d423e6537e5e338cdbf2c67432b431ec75cc90cc93dab8a9ceb980ac71` |
| `backends/sysbox.js` | `f6cfbdc5f1256b1e4da458e6c774088f1e00ee244327aafb1beaa65b6b3989e8` |
| `backends/container-artifacts.js` | `f2a0fa2adc542d6b8a0f847ba7bb95d3ef5882eddb0e180521fd8c58ea4f5576` |
| `worker.js` | `d04e79d3a2e1939b9e37d769873e6abb9b9933ccfb6b70779042b4a20638e5e2` |

## Remaining root gate and cleanup

No new normal DIM CI request/review/execution ID or accepted publication exists
for this candidate. Full exact-source build/strict/units/CLI/host/scenarios and
real stopped-Sysbox causal validation are **not reached**, not passed or waived.
Root must bind the final SHA/tree, exact worker/provider and full pinned image
digests, then verify accepted publication, command exit and complete downloaded
manifest/file/log SHA-256 and sizes. The original `0600` nonce smoke is the
required runtime proof; a successful process with unavailable artifacts fails it.
No VM runtime repeat is claimed or requested here.

Record the installed-210 missing DIM task-message operation as an API defect:
root's authorized normal OpenCode forward/authenticated-API delivery was the
dispatch workaround, not a new DIM capability implemented by this artifact fix.

All delegated exploration/review calls completed synchronously. The actual team
API returned an empty list; inspected process listings contained no remaining
test/producer process. Standing OpenCode/OMO and pre-existing workspace runtime
processes were not stopped. No task service or real runtime was started.
Original receipts/private operator evidence remain untouched. Generated `dist`,
existing dependencies and isolated Node tooling are retained; no fixture roots
remain. Only the ordinary task branch is pushed through its configured broker;
root owns integration, runtime validation and workspace lifecycle.
