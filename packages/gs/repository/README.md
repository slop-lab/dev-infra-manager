# @slop-lab/gs-repository

Git-owned repository initialization, executable/integrity verification, bounded
smart-HTTP transport and protected-ref transaction primitives. No DIM runtime,
Project registration, workspace record, activation protocol, scheduler or Web
shell is required. Namespace/repository selectors and principal-scoped grants
are independent of any DIM mapping.

`createRepositoryService` composes a small repository-only HTTP listener from
explicit trusted repository policies and a repository-scoped authorization
callback. It neither interprets `.dim` files nor enables review, PR, CI or
promotion implicitly. Ordinary writes cannot update configured protected refs.
An authorization callback cannot replace the repository owner's protected set.

Protected-ref orchestration uses concrete targets and intents bound to exact
namespace/repository, incarnation, authority epoch, policy digest, owner
principal and protected head. The only policy proof field is
`refPolicyRevision`. Journal calls must complete only after durable commit.
Recovery cancels an unapplied intent or finalizes an already-applied CAS; it
never reauthorizes or replays Git CAS. `@slop-lab/gs-repository-service`
supplies the independent SQLite catalog, policy, branch baseline, journal and
exclusive live-owner implementation. DIM maps its existing proof and format-12
journal inward without changing persisted transition bytes.

The durable journal also supports exact finalized-action lookup. Callers provide
the complete historical intent identity except sequence and receive the stored
intent plus original promoted receipt. This is the reconciliation boundary for a
feature crash after Git CAS but before its own receipt is finalized; current Git
state alone is never treated as proof of authorization.

Private receive-hook bytes and `DIM_NATIVE_GIT_*` environment marker names are
retained because existing owned repositories validate those exact stored bytes.
They are a persisted Git hook ABI, not a dependency on DIM code or credentials.
Do not change them or evidence digest domains as a namespace-renaming shortcut.

Build with `node ../build-package.ts` and the package's declared development
dependencies. The GS-owned build configuration can move with `packages/gs`;
`GS_BUILD_VERSION` is its optional explicit artifact-version override.
