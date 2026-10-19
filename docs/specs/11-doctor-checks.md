# Host diagnostics

`dim doctor` checks the selected development host. It checks Linux, Git, Docker
daemon access, the daemon's Sysbox registration, and the selected workspace
image. No Project, controller, managed Git service, CI host or plugin is needed.
An empty workspace list does not require a running Docker daemon.

Checks print `ok` or `fail`, a check name and a useful detail. `--json` returns
the check records. A failing check exits 2. Inspection does not provision host
services, start containers, prompt for sudo, or change system configuration.

This is a prerequisite diagnostic, not proof of a successful workspace boot.
Creation separately validates runtime resources and waits for private Docker
readiness. Disposable-host verification exercises actual isolation and nested
container execution.

Managed services have additional diagnostics under `dim doctor`.
Their linger, rootlesskit AppArmor, controller and plugin checks are scoped to
that integration; they are not base workspace prerequisites. Host provisioning
scripts remain responsible for installing the runtime's system dependencies.
