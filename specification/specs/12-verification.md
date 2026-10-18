> Scope: optional managed integration. Base workspace behavior is defined in
> [the specification index](README.md); this document does not require managed
> services for ordinary development.

# Verification

**Kind: Verification**

## Required native evidence

**VERIFICATION-NATIVE-LIFECYCLE-001:** Tests must bootstrap one reviewed local
root, create/list/show a schema-6 ready Project, create/show a schema-9 native
workspace while CI is unavailable, and exercise setup/restart plus a real Git
proposal push. Protected writes, delete, force, tag, foreign-workspace, and
foreign-Project access must leave refs unchanged. Readiness creates no CI,
review, approval, or promotion authority.

Strict rejection tests retain historical provider-backed Project/workspace
records only as input fixtures. They must remain byte-identical and receive
prior-release export guidance. No successful test may start, contact, adopt,
or clean a provider service.

**VERIFICATION-NATIVE-CI-001:** A real ordinary mechanics phase must run one
digest-pinned bounded Sysbox job and prove terminal output plus owned cleanup.
A distinct QEMU mechanics phase must run a real KVM guest job and prove fixed
argv, guest bounds, output, and owned cleanup. Hardware absence is unavailable;
TCG and ordinary evidence cannot satisfy the QEMU phase. Both results are
`candidate-controlled`.

**VERIFICATION-NATIVE-PROMOTION-001:** Deterministic native Git tests must keep
exact current-generation, wrong-kind, missing, failed, stale, foreign,
mismatched, replay, old-attempt, policy, tree, and protected-head denials. A
successful protected update requires a current exact-tree human approval,
every policy-selected current result, and one checked compare-and-swap.

## Evidence classes

The repository reports three different outcomes:

1. Deterministic contract tests validate parsers, state machines, role
   separation, current-generation fences, compare-and-swap, and cleanup rules.
2. Same-host mechanics run actual installed services, a real Sysbox job, and a
   real KVM guest on one disposable host. They prove mechanics, not independent
   execution or human release acceptance.
3. Full release acceptance uses separately administered ordinary and QEMU
   hosts, reviewed exact source/image digests, effective traffic and guest
   authority inspection, reboot/crash recovery, operator review, and real human
   approval. It is recorded by an operator and is never emitted automatically.

`VERIFICATION-NATIVE-CUTOVER-001` passes only at level 3. Reviewer fixture
posts may prove the protocol at levels 1 or 2, but must not be labelled human
approval and must never promote a pre-existing protected ref.

## Executable gates

```bash
just check-source-native
just verify native-idle-service-images
just verify control-plane-install-live
just verify native-basic-lifecycle
just verify native-ordinary-guest-mechanics
just verify native-qemu-guest-mechanics-kvm
bash verification/scripts/kvm-guest-verification-smoke.bash
```

The guest aggregate runs independent native phases through the shared stage
runner. It prints `PASS`, `FAIL`, and dependency-derived `BLOCKED` records,
retains mode-`0600` logs, forwards cancellation to the active process group,
and returns `125` when cleanup is uncertain. Missing architecture, Docker,
Sysbox, KVM, pinned images, or required network access exits `2` as unavailable,
not `0`.

The aggregate must not launch a Gitea service, register an Actions runner,
consume a provider webhook, or use repository/Project purge as cleanup. It
removes only exact run-owned resources. Existing provider containers, volumes,
remotes, credentials, and repositories remain untouched.
