# Real shared QEMU job completion

This capability-gated fixture proves two logical DIM hosts can share one
standalone scheduler and external Gitea Project while each runs an actual
production one-job QEMU supervisor. It does not replace QEMU with TCG or a
stub supervisor.

Run it inside the prepared x86-64 verification guest:

```bash
just verify real-shared-qemu-jobs-kvm
```

Prerequisites are a reachable Docker daemon, readable and writable `/dev/kvm`,
nested KVM, outbound access to the pinned Ubuntu, HashiCorp, Gitea runner, and
Docker Hub artifacts, and at least 4 GiB guest RAM. The host-side authorization
for the parent verification launch remains outside this fixture; when the
parent uses the protected QEMU service, `DIM_QEMU_VERIFICATION_SOCKET` must
already point at that service. This fixture never starts or upgrades it.

The default budget is one active job VM at a time with one vCPU and 768 MiB
RAM. The production supervisor receives 2 GiB additional container headroom.
`DIM_REAL_SHARED_QEMU_JOB_MEMORY_MB` may be set from `768` through `1024`.
`DIM_REAL_SHARED_QEMU_TIMEOUT_SECONDS` defaults to 3600 seconds and establishes
the absolute deadline later checked while polling the two workflows. Its clock
starts before image construction, but the fixture does not interrupt a build;
a long build reduces or can exhaust the remaining workflow polling window.
Each production build instead runs under the outer verification service's
long-running command limit. The 56 GiB parent host cap is not changed.

The fixture serializes both host image preparations and workflow assignments:
host A finishes and is removed before host B receives its workflow. Each host
has a distinct scheduler host ID, state root, data volume, common-image volume,
Project-image volume, runner name, and readiness authorization. Gitea,
scheduler, registry cache, containers, networks, images, and volumes receive a
per-run suffix. Git identity and credentials are command-local.

On every exit, the trap removes both workers, the disposable services, all
per-run volumes and networks, and fixture-built images. It restores a prior
`dim-qemu-ci-supervisor:0.9` tag if one existed. The fixture runs against a
dedicated disposable Docker daemon: cleanup records the image currently under
that build tag before restoring it, then requests non-force removal only for
recorded fixture image IDs, so another tag prevents deletion. Sanitized
evidence remains at
`.local/verification/real-shared-qemu-*` by default; override its parent with
`DIM_REAL_SHARED_QEMU_EVIDENCE_ROOT`. The final JSON line and stderr both print
the exact artifact path.
