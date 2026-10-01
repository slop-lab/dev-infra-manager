# Doctor Checks

## Scope

`doctor` verifies common host dependencies and the Sysbox workspace backend.
It must also run when no backend is configured, report the missing
configuration, and report whether Sysbox is currently usable.

`dim doctor configure-backend [sysbox]` verifies Sysbox before recording it.
Any other backend argument or stored value must be rejected.

## Output

Each check prints `<ok|fail>\t<name>\t<detail>`. If any check fails, the CLI
exit code is `1`.

## Common Checks

Always check Node.js, pnpm, just, git, `script`, `stty`, the user systemd
manager, user linger, AppArmor unprivileged-user-namespace readiness, Docker
CLI and daemon reachability, and cgroup v2 availability. Docker daemon checks
should retry with sudo when the first failure contains `permission denied`.

`DOCTOR-HOST-LINGER-001`: `doctor` MUST query the current user with
`loginctl show-user <uid> --property=Linger --value`. Only `yes` is ready. A
disabled or unavailable result MUST fail with the remediation
`sudo loginctl enable-linger $USER`.

`DOCTOR-HOST-APPARMOR-001`: `doctor` MUST query
`kernel.apparmor_restrict_unprivileged_userns`. An unavailable setting is not
applicable, and value `0` means the restriction is disabled; both are ready
without a rootlesskit profile. Value `1` is ready only when the loaded
AppArmor profiles include `/usr/local/bin/rootlesskit`. A restricted host
without that loaded profile MUST fail and identify the missing profile.

These diagnostics MUST NOT enable linger, load an AppArmor profile, or
otherwise change host configuration. Reading the root-only AppArmor loaded
profile list with `sudo` is permitted.

## Sysbox Checks

- `sysbox-runc --version`
- `systemctl is-active sysbox.service`
- host Docker registration for `sysbox-runc`
- `docker run --rm --runtime=sysbox-runc --pull=missing hello-world:latest`

KVM is an optional workspace capability and MUST NOT be a Sysbox doctor
prerequisite.

## Verification

Required unit verification covers successful Sysbox execution, sudo retry,
first-line Docker errors, absence of a KVM backend prerequisite, enabled and
disabled linger, AppArmor restriction absence and disablement, and restricted
hosts with and without the loaded rootlesskit profile. A clean QEMU install
gate verifies the recorded Sysbox backend.
