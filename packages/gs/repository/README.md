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

Protected-ref orchestration uses typed target-proof, policy and durable-journal
ports under explicit serialization. Journal calls must complete only after
durable commit. Recovery cancels an unapplied intent; it never replays old
authorization. A standalone durable journal implementation is not supplied by
this preparation checkpoint. DIM binds its existing proof and format-12 journal
outside this package; repository-only operation needs neither.

Private receive-hook bytes and `DIM_NATIVE_GIT_*` environment marker names are
retained because existing owned repositories validate those exact stored bytes.
They are a persisted Git hook ABI, not a dependency on DIM code or credentials.
Do not change them or evidence digest domains as a namespace-renaming shortcut.

Build with `node ../build-package.ts` and the package's declared development
dependencies. The GS-owned build configuration can move with `packages/gs`;
`GS_BUILD_VERSION` is its optional explicit artifact-version override.
