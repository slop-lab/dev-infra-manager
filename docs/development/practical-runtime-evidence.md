# Practical runtime acceptance ledger

This is a source checkpoint, not completed multi-host/runtime acceptance.
Base commit: `f74e7a854c65a9d82014abe5f14b4265ec544cda`.
The exact checkpoint commit/tree and bundle hash belong in the private handoff
manifest, avoiding a self-referential source receipt.

## Completed source checks

| Lane | Status | Evidence and limit |
| --- | --- | --- |
| Full strict workspace check | PASS | `pnpm workspace:check`, all 76 checked workspace projects, Node 24.22.1 / pnpm 10.13.1 |
| Affected builds | PASS | host core/contracts, host LLM-router and VM packages |
| LLM recovery and generic transport/wire | PASS | 5 files / 32 tests: gateway/control-plane HTTP fixtures, real stdio helper processes and frozen CLI-host contract tests; not provider inference or KVM |
| Selected-host scenario boundaries | PASS | 14 files / 55 tests: `pnpm --dir tests exec vitest run scenarios/selected-host --exclude 'scenarios/selected-host/runtimeStdio.test.ts' --no-file-parallelism`; includes ordinary/managed profiles, application HTTP schema, isolated environment, cleanup, command-evidence redaction, VM cleanup order, nested probe argument boundary and monitor checks |
| Example verify command | PASS | `node scripts/examples/run.ts examples/features/ordinary-workspace verify`; 3 files / 19 tests, a subset of the preceding source checks |
| Public driver surface | PASS | real terminal help; invalid/missing arguments return JSON `OperatorInputError`, exit 2, without creating resources |

Source evidence logs are retained outside the checkout under
`/mnt/dim-tmp/opencode/opencode/practical-source-*` and
`practical-checkpoint-*`. They are local source evidence, not authoritative CI.
LSP diagnostics cannot access this external worktree from the request cwd;
complete strict compiler checks are the available replacement.

## First failure and fixed-after evidence

- The new legacy-selection positive regression failed against the base with the
  old reattach-only error. After the owner fix, the recovery suite passes and
  proves token/principal count unchanged, original-gateway current-binding
  validation, wrong-gateway denial and actual scoped HTTP responses.
- The ordinary-source profile regression failed against the managed-only parser.
  It now passes without requiring Native Git or CI; credential-bearing URLs and
  implicit relative source paths remain denied.
- The source-only preflight initially required a built Native CI package even for
  ordinary sources/help. Native CI is now loaded only by the managed-source
  subjourney; offline help and actual fixture CLI preflight checks pass.
- Review found integration preparation outside the readiness wrapper. The whole
  source integration + agent + plugin sequence is now centralized, and tests
  cover recording failure before agent execution. Review also identified VM
  cleanup ordering: revocation failure no longer suppresses UUID-pinned discard.

## Runtime and source-authority prerequisites

| Lane | Status | Actual observation / next requirement |
| --- | --- | --- |
| Canonical base identity | PASS | Coordinator supplied `canonical-base.bundle`; `git bundle verify` succeeds, its HEAD is `f74e7a854c65a9d82014abe5f14b4265ec544cda`, tree `5bcd2008b5ca3e36463ef0f3a524fe8126f0eaa0`, and it is this branch's ancestor. Guest GitHub credentials remain absent; online fetch is not a remaining base-selection prerequisite |
| Kernel-lock-dependent readiness and VM claim regressions | PASS for recorded draft snapshot | Coordinator's healthy Linux run: 4 files / 28 passed tests, real boot ID and production locking, no stubs/bypass. The guest's earlier 23 failures / 5 passes remain environment-failure evidence. See the exact snapshot qualification below; a later HEAD is not automatically covered |
| Existing disposable Docker stdio-image gate | BLOCKED | Build failed with `mount ... function not implemented`; no image was returned |
| Disposable runc container preflight | BLOCKED | Immutable local Alpine image run failed at overlay mount creation (`function not implemented`); exact test container name was absent afterward |
| Local/SSH Sysbox user journey | BLOCKED | Local daemon lists runc only, no Sysbox; reviewed disposable host/profile needed |
| Real scoped provider inference / OpenCode / application ingress | BLOCKED | No reviewed disposable project/account/gateway/ingress profile supplied; live application or fleet credentials were not inspected |
| Agent-discovered auxiliary VM | BLOCKED | No reviewed Incus runtime host/image profile supplied; guest `/dev/kvm` absence is not being interpreted as host unavailability |
| Isolated installation update | BLOCKED | Requires distinct reviewed before/after facades and complete local bundles plus immutable image on the disposable runtime host; no fleet installation was attempted |

## Reproduction entry points

```sh
just verify selected-host-smoke --help
just verify selected-host-smoke --config /absolute/private/hosts.json \
  --host local --host disposable-ssh --preflight-only
just verify selected-host-smoke --config /absolute/private/hosts.json \
  --host local --host disposable-ssh --json
```

Use the schema and safety contract in
`tests/scenarios/selected-host/README.md`. Complete runs require a clean committed
driver checkout, bind `driverSourceSha` separately from installed provenance,
retain sanitized command surfaces/exits/timings and report per-lane
`PASS`/`FAIL`/`BLOCKED`. Missing heavy-lane inputs remain incomplete, not success.
Actual SSH/provider/Incus/update qualification is still required before calling
this task complete or requesting rollout.

## Latest continuation checkpoint

The latest source edits were rechecked with the full strict workspace command,
affected package builds, the 5-file/32-test recovery and protocol selection,
the 14-file/55-test selected-host selection, and the example verify command.
The CLI was exercised in a real terminal: help was readable and missing required
arguments with `--json` returned `OperatorInputError` and exit 2. `git diff --check`
was clean. These checks originally covered the draft based on
`6613098f2f85504fe1a3cfa81f7d339591742aeb`; checkpoint commits preserve that source
work without converting pending runtime lanes into passing acceptance.

Smoke reports now retain guest Node, kernel and private Docker server versions
from executed probes, including when a later step fails, and print those versions
in terminal mode; malformed or unsupported metadata fails the lane. The reporting
correction passed `pnpm check:tools` and the 14-file/55-test source selection.
These probes have not run against a live workspace here. Installed plugin version
attestation still requires the selected installation's reviewed manifest; plugin
presence and an operator-declared source SHA are not that attestation.

## Healthy Linux snapshot qualification

The coordinator retained the private `draft-snapshot.json` and
`healthy-focused.log` under `/home/dim/tasks/dim-practical-runtime-20261106/`.
The recorded snapshot was taken at `2026-11-06T08:17:48.652Z`, based on
`6613098f2f85504fe1a3cfa81f7d339591742aeb` plus its enumerated tracked and
untracked changes. Its tracked patch SHA-256 is
`71b65130a4ad379e8e542dfe1f562148d895b22ed15c0d7b2f80a7207ebaa5e9`;
its untracked archive SHA-256 is
`7f4cb6e2ee56c58c3ec087723a12ba665dff06a40acd413fcebf194696c39155`.
Stable pre/post hashes were reported by the coordinator.

That snapshot passed workspace-agent (14), VM grants (9), source preparation
(1), and readiness (4): 28/28 tests across 4 files. This is source behavioral
evidence, not provider/ingress/Incus/update runtime acceptance and not a claim
that subsequent edits or a later commit were executed on the healthy host.
