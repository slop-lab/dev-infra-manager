# Real shared QEMU job completion evidence

## Observed run

On 2026-09-24, a scoped fixture ran through the existing protected QEMU
verification service without changing the installed host DIM or trusted
launcher. The candidate input archive SHA-256 was
`950e8bb64b0002dded739ebab53d8d9cad92d7bfe83f90487235ec37ecb81930`.

The outer guest had 4 GiB assigned memory. The two logical executor contexts
used independent host IDs, state roots, runner registrations, and data/cache
volumes. They ran sequentially, with one 768 MiB job VM active at a time.
They shared the disposable outer guest's kernel and Docker daemon, so this is
not evidence of two physically separate hosts or simultaneous VM job execution.

Both contexts used the production supervisor, signed/pinned image inputs,
real KVM acceleration, ephemeral Gitea registration, and `daemon --once`.
No fake one-job process replaced the production supervisor.

| Context | Gitea run/job | Runner suffix | Job marker | Conclusion |
| --- | --- | --- | --- | --- |
| Host A | 1 / 1 | `lwawsz-host-a-qemu` | `dim-real-shared-qemu-marker-a` | success |
| Host B | 2 / 2 | `lwawsz-host-b-qemu` | `dim-real-shared-qemu-marker-b` | success |

The fixture observed two completed scheduler jobs and zero outstanding claims,
then printed `real-shared-qemu-jobs-smoke-ok`. Its scoped wrapper exited 0.
Failure-cleanup bookkeeping and diagnostic suppression were subsequently
improved and verified by unit tests; those changes do not alter job execution.

## Defects discovered during execution

- A restrictive caller umask made the public APT CA unreadable. Supervisor
  assets now explicitly retain their intended modes without changing TLS,
  signatures, or dependency pins.
- The image preparation script pre-created Packer output directories, which
  real Packer rejects. Packer now creates those directories itself.
- Docker 29's containerd image store can drop a previously untagged build when
  another build replaces the shared supervisor tag. The two-host fixture now
  retains its first image with a fixture-owned tag until cleanup.
- Fixture corrections include an explicit `sh` job shell for Alpine, graceful
  worker shutdown, failed-job log capture, repeated-failure bounds, and result
  predicates that execute correctly with empty stdin.

## Deliberate limits

The old protected launcher continued with additional legacy checks after the
scoped fixture passed. Its later managed-CI cgroup test failed with
`Project .dim/ci/runner.yml is required`. The whole launcher therefore reported
failure; this evidence must not be described as a complete full-development
gate pass.

Gitea runner 3.2.0 also reported that `--device /dev/kvm` is ignored while job
container privileged mode is disabled. This run proves KVM-backed runner VMs
and real job completion, not additional KVM access inside the job container.
No container privilege policy was relaxed to make the test pass.

The temporary agent-owned recipe routing was restored. The host installation,
trusted root checkout, verification service, live Gitea, and live gateway were
not modified. Disposable VM and fixture resources were cleaned up.
