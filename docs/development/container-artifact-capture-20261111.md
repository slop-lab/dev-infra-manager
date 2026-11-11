# Container artifact capture: diagnostic candidate, 2026-11-11

## Candidate and scope

- Workspace: `dim-artifacts`; branch: `work/container-artifacts-20261111`.
- Exact public base: `96e5ecadb6d93061d655303094729cb1332dee16`.
- Implementation commit: `0028177f9fc1d7ce59456d8222a1f0a86a024e48`;
  tree: `e142e2fb633fc25ba0925c3f0289b7f92a1ac19c`.
- The final branch-tip commit/tree, including this report, are recorded in the
  handoff rather than recursively embedded in this file.

This candidate fixes lost diagnostic information, **not the unproven historical
Sysbox capture cause**. Manifest-producing failures now report a closed operation
and allowlisted errno, or `rejected`/`unknown`, without raw messages or paths.
The fixed root, no-follow opens, regular-file/single-link checks, stability and
collection bounds, cleanup ordering and private pending copies are unchanged.
There are no new production dependencies, runtime adapters or authority grants.

Production changes are confined to `execution-worker/src/artifacts.ts`. Its owner
README explains the existing host-readability requirement, unchanged private-file
semantics and the inability to diagnose manifest persistence through a missing
manifest. The changelog folds this into the existing retained-artifacts outcome.

## Original evidence, not new qualification

The supplied evidence identifies synthetic repository `vm-smoke-20261111`,
candidate `90606ae65f7f73fae05cfb2e8dff80c104f38a0e`, tree
`cb04e49c0263587e7077cb9de5e34399ff8da848`, independent root
`217ef0d9110dc5604e4f05d03d1793d12e7de642`:

- Request: `dbf23d45-8864-469d-875d-4cb7bea754b2`.
- Review: `94840c605ffe9ae6f11b3cea88a6e729067c7d3a8d840c3c95f592234fe67b85`.
- Supplied current execution label: `EE37`.
- Three required publications were accepted/successful, with command exit `0`.
- Container execution: `b6572e6c-bdf1-44f5-a576-490b63389d90` on existing
  `ci-remote-sub-2/build-2`, provider `ordinary-sysbox`.
- Container manifest: `unavailable`, `artifact-capture-failed`; both logs retained,
  `files/container.json` absent. Successful command execution is not complete
  artifact capture.

The archive was read without extraction into, or changing the origin of, the
checkout. Its public smoke source writes the normal artifact path with `0600`.
Historical host UID/GID/mode/link count, exact failed syscall and installed owner
source hashes remain unknown. The post-cleanup journal is absent. UID remapping
is a hypothesis, not a finding. No installed-worker/source equivalence is claimed.

Independently recomputed from the supplied archive in this workspace:

| Retained bytes | Size | SHA-256 |
| --- | ---: | --- |
| Evidence archive | 10,167 | `eebcba63d536794a34de25a2c31f6691cfc6638a541c3f6d7a74b70563a84e5f` |
| Container manifest JSON | 661 | `ab4f54538d66bed5486a8923bad0ef9b59b20c310b428ce876afd1e9807c7f6d` |
| Container stdout | 356 | `fba75f35bb04940087cf990f589350c62fd2f6e1d5fcf7fba35a65a2048bc4cb` |
| Container stderr | 0 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |

Both log sizes/hashes match the retained manifest. The supplied VM comparison
reports complete four-file manifests per VM, eight files/304,587 bytes, and ten
retained files/304,943 bytes overall. Those VM bytes were not independently
downloaded again here; this candidate makes no new VM qualification claim.

## Focused development verification

Available workspace runtime: Node `24.18.1`. Node `26.12.1` was run from an
isolated musl build, not installed into a service or profile:
`/mnt/dim-tmp/opencode/opencode/node-v26.12.1-linux-x64-musl/bin/node`.
The 37,265,884-byte archive matches the upstream unofficial-builds SHA-256 list:
`5c3834652a0fb8f204e6df76be1469aa99a9d18011fb79cc85d97c822184d976`.

Commands below ran from the checkout unless otherwise noted. For Node 26,
`NODE26` denotes that exact executable, not a changed global selection.

| Command | Exit | Observed result |
| --- | ---: | --- |
| `pnpm install --frozen-lockfile` | 0 | Locked dependencies installed; no tracked manifest/lock change |
| `pnpm --filter @slop-lab/dim-host-plugin-execution-worker run check` | 0 | Owner strict source check |
| `pnpm --filter @slop-lab/dim-host-plugin-execution-worker... run build` | 0 | Topological ten-package dependency closure built |
| `pnpm --dir tests exec vitest run host/plugins/execution-worker/artifacts.test.ts scenarios/execution/execution.test.ts --no-file-parallelism` | 0 | Final Node 24 run: 28 passed, two files |
| `NODE26 node_modules/vitest/vitest.mjs run host/plugins/execution-worker/artifacts.test.ts scenarios/execution/execution.test.ts --no-file-parallelism` from `tests/` | 0 | Final Node 26 run: 28 passed, two files |
| `pnpm --dir tests exec tsc -p tsconfig.json --noEmit` | 0 | Final Node 24 strict test check |
| `NODE26 tests/node_modules/typescript/bin/tsc -p tests/tsconfig.json --noEmit` | 0 | Final Node 26 strict test check |
| `NODE26 tests/node_modules/typescript/bin/tsc -p packages/host/plugins/execution-worker/tsconfig.json --noEmit` | 0 | Node 26 owner strict check |
| Built-module Node 24 driver, importing `dist/artifacts.js` directly | 0 | Readable `0600`: complete, three artifacts; unreadable input: unavailable with `source-open:EACCES`, two logs; all sizes/SHA-256 and persisted manifest verified; modes unchanged; fixture removed |
| `git diff --check` | 0 | No whitespace errors |

Eight real-filesystem regression scenarios cover readable `0600`, unreadable
file/directory `000`, a hardlink, empty missing spools, nonempty missing stdout,
unreadable stderr after retained stdout, and unlisted errno closure using an
overlong path. Fixtures verify retained bytes, SHA-256, private destination modes,
unchanged source modes/link counts, manifest persistence and log fallback.

Permission cases run in a dedicated child. A root-started child clears its own
supplementary groups and drops GID/UID to 65534 after imports and before creating
data. The test runner/host identity is never changed. This workspace exercised
the natural nonroot path only. Root qualification must record an initial UID-0
precondition and run these same cases; credential-drop failure is a real failure,
not a skip. No global permission/UID bypass or containment relaxation was used.

Static Oracle review completed twice, including the child-fixture delta, with no
concrete safety/correctness finding. LSP diagnostics were unavailable because the
TypeScript language server is absent; no server was installed. Compiler checks
above are the available strict verification. Changed TypeScript files are at
most 91 total lines each. Responsibilities remain capture, test registration and
an isolated permission fixture; no type-suppression escape hatches were added.

## Failures retained, not retried into qualification

- Initial failing-first capture run: three failures/three passes. Actual file and
  directory permission errors and hardlink rejection were collapsed to the old
  generic error. The new diagnostics made these distinctions observable.
- A broader local command, `pnpm --dir tests exec vitest run
  host/plugins/execution-worker scenarios/execution --no-file-parallelism`,
  failed: 37 failed, 135 passed, one skipped; ten failed files, 23 passed, one
  skipped. Failures included local Git fixture HTTP 500s, a missing built
  `gs-ci-contracts` module, and a Native Git process failure. The broader suite
  was not rerun. These are not silently waived; their full baseline causes were
  not investigated as part of this capture-only task.
- The first owner-only build exited `2` because dependency `dist` trees did not
  exist. The later dependency-closure build explicitly built those prerequisites
  and exited `0`; the initial failure remains recorded above.
- The npm-distributed Node 26 glibc binary could not start on musl (missing
  `libatomic` and incompatible symbols). Its numeric loader exit was not retained.
  The separate checksum-verified musl distribution supplied the final Node 26
  evidence; no system library, service or profile was changed.
- The first child-harness runs failed on both versions: eight failures/20 passes
  each, because Vitest's import-meta shim has no `resolve`. Replacing it with
  Node's `createRequire` resolver changed the failing input. Final runs above
  passed without assertion removal, budget increases or blind reruns.

## Required root-coordinated follow-up

No DIM CI was requested for this diagnostic candidate. New request/review/
execution IDs, worker/provider, accepted publication and remote manifest
integrity are therefore **not available**. Full exact-source build/strict/
units/CLI/host/scenarios and the causal container smoke are **not reached**,
not successful or waived. Local development checks are not the normal DIM CI gate.

After root review, root coordinates one normal exact-commit source gate and one
tiny authorized container smoke using the original normal-path `0600` input.
Bind the run to candidate SHA/tree, request/review/execution, installed public
owner hashes when supplied, actual worker/provider, accepted result and command
exit. Retain the new closed capture code before cleanup and verify all downloaded
manifest entries by size/SHA-256, including both logs and `files/container.json`.
An unavailable manifest is still incomplete even with exit `0`. If permissions
are implicated, obtain only root-authorized bounded metadata for that exact
artifact/root through the reviewed normal worker path, not a host scan or a
service restart. Do not infer host ownership from guest metadata. No VM repeat
or privilege-bearing workspace reproduction was performed or requested here.

## Cleanup and retained state

Both exploration agents and both synchronous Oracle invocations completed before
handoff. The actual team API returned an empty list. The optional disk metadata
adapter reported `unreadable: true`; it is not evidence of global agent idleness.
Process inspection showed no remaining test/driver process; the standing
OpenCode/OMO harness processes and pre-existing workspace runtime were untouched.
No task service, Docker/KVM runtime reproduction or background job was started.
Every permission/driver fixture removes its own temporary root.

Original staged receipts remain unchanged under `/home/dim/tmp/dim-delegation/`.
Locked `node_modules`, generated dependency/package `dist` trees, the isolated
musl Node archive/checksum/extraction under `/mnt/dim-tmp/opencode/opencode/`, and
the unsuccessful npm Node download cache are retained for reproducibility, not
deployed. Root owns workspace lifecycle. Only this ordinary task branch is
eligible for the requested broker push; no protected ref, PR, promotion, merge,
publication, service configuration or user workspace was changed.
