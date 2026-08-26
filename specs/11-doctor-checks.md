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
manager, Docker CLI and daemon reachability, and cgroup v2 availability.
Docker daemon checks should retry with sudo when the first failure contains
`permission denied`.

## Sysbox Checks

- `sysbox-runc --version`
- `systemctl is-active sysbox.service`
- host Docker registration for `sysbox-runc`
- `docker run --rm --runtime=sysbox-runc --pull=missing hello-world:latest`

KVM is an optional workspace capability and MUST NOT be a Sysbox doctor
prerequisite.

## Verification

Required unit verification covers successful Sysbox execution, sudo retry,
first-line Docker errors, and absence of a KVM backend prerequisite. A clean
QEMU install gate verifies the recorded Sysbox backend.
