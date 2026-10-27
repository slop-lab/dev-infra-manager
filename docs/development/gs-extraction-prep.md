# Git service extraction preparation

Base: approved development `c52eec55bbe29fe79b5f9a07db0dc081161a99a3`.
This is an in-monorepo preparation checkpoint, not a repository launch,
publication, deployment, or claim that every Git feature is extraction-ready.

## Observed dependency cuts

- Repository transport/storage primitives are Node-only, but their current
  public selectors expose DIM Project/workspace names. Protected-ref orchestration
  directly loads DIM activation/import proofs and format-12 SQLite records.
- The repository extension SDK imports the DIM control-plane framework; optional
  review, merge, PR, CI and sync plugins still depend on that SDK.
- Git-CI contracts depend on DIM execution contracts; scheduled tracing depends
  on DIM execution clients. CI does not require the PR plugin.
- The Native Git service client combines portable models with DIM operation,
  role-attestation and connection conventions. Host and Web packages are adapters.
- Six Git model/React libraries are already DIM-independent. The tracing
  evaluator is neutral except for its DIM runtime-registration wrapper.

## Implementation order

1. Establish the movable `packages/gs/*` owner with GS-only build configuration.
   Move the portable model/UI libraries and neutral tracing implementation to
   `@slop-lab/gs-*`; update consumers and artifact composition without aliases.
2. Move the existing repository initialization, executable verification, CGI
   backend, routing and atomic Git primitives into `gs-repository`. Public
   selectors use namespace/repository and principal identity, not DIM records.
   Keep a DIM translation boundary for existing Project/workspace interfaces.
3. Extract protected-ref ordering behind target-proof, durable-journal and
   policy-provider ports plus an explicit serialization boundary. Bind existing
   DIM proofs/state at the adapter; do not duplicate a scheduler or state engine.
4. Run a minimal GS HTTP composition outside DIM registration/activation with
   real Git reads/writes, protected-write denial and repository-scoped grants.
   Run existing DIM protected-ref, review, PR and sync regressions where affected.
5. Update ownership, package/build/install metadata and outcome-oriented release
   notes. Record exact remaining reverse dependencies rather than relabeling
   DIM-coupled packages as independent.

## Invariants and verification

- No GS source, type, runtime or build dependency on DIM packages/frameworks.
- Preserve existing receive-hook bytes and persisted digest/journal domains;
  those private storage markers are not permission to depend on DIM code.
- Preserve intent-before-CAS, exact candidate/tree/base/policy/issuer bindings,
  fail-closed required providers and recovery that never replays authorization.
- Standalone hosting does not imply standalone durable protected promotion:
  any missing independent journal implementation remains an explicit blocker.
- All test implementations stay in `tests/`; use disposable real Git/HTTP state,
  strict checks and package builds, not static import checks alone.
- No changes to prior worktrees, live services, credentials, runtime installation,
  protected refs, the installer facade or frozen CLI-host v1 fixtures.
