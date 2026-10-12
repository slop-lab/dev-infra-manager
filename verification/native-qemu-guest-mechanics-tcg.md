# Native QEMU guest-mechanics TCG verification

`just verify native-qemu-guest-mechanics-tcg` boots the shipped native-QEMU
kernel and initramfs in a real Docker-hosted QEMU VM with explicit TCG
acceleration. It verifies guest boot, the fixed Bash argv, writable candidate
workspace and `/tmp`, read-only kernel control mounts, non-root execution, and
an enforced cgroup-v2 PID limit.

This lane is verification-only. Its evidence classification is
`guest-mechanics-not-KVM-acceptance`. It does not exercise `/dev/kvm`, satisfy
native-QEMU capacity preflight, or replace clean-host KVM acceptance. The
production runner remains explicitly `accel=kvm` and missing KVM remains
`unavailable` without fallback.

The fixture builds uniquely tagged disposable runner and job images. It stages
the job image root with `docker export` into a fixture-owned private Docker
volume, so the guest mechanics can be exercised on daemons that do not support
Docker `type=image` mounts. This staging method is not a production execution
alternative. Separate private volumes contain only the read-only job inputs
and the writable candidate marker/artifacts. No host device, Docker socket, or
additional privilege is passed into the runner container.

Evidence is written under
`.local/verification/native-qemu-guest-mechanics-tcg-*` unless
`DIM_NATIVE_QEMU_TCG_EVIDENCE_ROOT` selects another parent. `summary.json`
records the explicit TCG classification, QEMU debug-exit status, PID bound,
full image IDs, kernel/initramfs hashes, and private-volume staging method.
`guest-console.log` and `workspace/` contain the real kernel command line,
fixed argv, candidate UID/capability state, cgroup state, rejected control-file
writes, fork-pressure rejection, and marker bytes.
