# Verification

Test behavior at the component that owns it: parsed state and transitions,
process cancellation, SSH byte streams, exact runtime ownership, persistent
storage, scoped source access, Git/ref races, execution fencing and installer
recovery. Do not retain tests solely to pin a retired schema or source layout.

Base acceptance needs ordinary Git workspace creation and daily operations
without managed packages or services. Verify local and actual SSH paths,
stdin/exit status, binary TCP forwarding, cancellation, resource updates,
stop/start/recreate data preservation and explicit owned discard.

Managed acceptance adds a first-Project journey, real scoped proposal pushes,
protected/foreign ref denial, review and checked promotion, then continued use
of the existing workspace after protected-ref advancement. CI absence must not
block source readiness. Optional controller tests cover current UUID grants,
agent/private-Docker target resolution, connection forwarding and name reuse.
Browser verification uses the installed review API rather than a substitute
backend retained for browser fixtures.

Execution acceptance covers one durable job/attempt/lease/result lifecycle,
cleanup before capacity reuse, expiry/recovery, stale worker fencing and Git
publication retries. Real Sysbox and real KVM mechanics are distinct evidence.
Missing KVM is unavailable; mocks, TCG or ordinary containers cannot establish
KVM behavior. Candidate-controlled results never establish human approval.

Scoped auxiliary-VM acceptance additionally proves discovery without repository
configuration, exact workspace/VM identity, stdin/stdout/stderr/exit and signal
behavior, binary push/pull, unauthorized-workspace denial, revoke during active
streams, stop/start reconnect, retained VM data and exact cleanup. Direct
`container-kvm`, Incus VM workspaces and auxiliary VM attachments are separate
claims. The required runtime runner must fail unavailable when its reviewed
images, private state parent, KVM probe, Sysbox or real KVM device are missing;
skipped tests are not successful required evidence.

Use disposable names, directories, repositories and resources. Cleanup removes
only exact run-owned resources. Never replace running host installations as a
side effect of source checks. Full package builds and selected tarball install
checks must use a matched snapshot; concurrent dist replacement is not a valid
test environment.

Deterministic tests, same-host physical mechanics and independently operated
multi-host/release acceptance are separate claims. Record what actually ran,
what was unavailable and any remaining concrete limitation. A script name or
historical specification is not evidence that the current architecture passed.

See [host readiness](../development/host-install-readiness.md) and the
current [verification recipes](../../just/verify.just) for executable
checks. The architecture plan maps the preserved issue backup to workstreams.
