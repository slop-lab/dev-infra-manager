# Native QEMU guest-mechanics KVM verification

`just verify native-qemu-guest-mechanics-kvm` boots the shipped native-QEMU
kernel and initramfs in a real Docker-hosted QEMU VM with `accel=kvm`. It
verifies guest boot, the fixed Bash argv, writable candidate workspace and
`/tmp`, read-only kernel control mounts, non-root execution, and an enforced
cgroup-v2 PID limit.

The lane requires an accessible character `/dev/kvm`. Missing KVM, Docker, or
required build inputs is `unavailable` with exit `2`; there is no TCG fallback.
A successful run is same-host guest-mechanics evidence. It does not replace
independent-host release acceptance, human review, or checked protected-ref
promotion.

The fixture builds uniquely tagged disposable runner and job images. It stages
the job image root with `docker export` into a fixture-owned private Docker
volume. Separate private volumes contain only read-only job inputs and the
writable candidate marker and artifacts. No Docker socket or unrelated host
device is passed into the runner container.

Evidence is written under
`.local/verification/native-qemu-guest-mechanics-kvm-*` unless
`DIM_NATIVE_QEMU_KVM_EVIDENCE_ROOT` selects another parent. `summary.json`
records KVM acceleration, QEMU debug-exit status, PID bound, full image IDs,
kernel and initramfs hashes, and private-volume staging. `guest-console.log`
and `workspace/` contain the real kernel command line, fixed argv, candidate
UID and capability state, cgroup state, rejected control-file writes,
fork-pressure rejection, and marker bytes.
