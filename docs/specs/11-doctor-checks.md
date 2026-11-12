# Host diagnostics

`dim doctor` checks the selected development host. It checks Linux, Git, Docker
daemon access, the daemon's Sysbox registration, and the selected workspace
image. No Project, controller, managed Git service, CI host or plugin is needed.
An empty workspace list does not require a running Docker daemon.

Checks print `ok` or `fail`, a check name and a useful detail. `--json` returns
the check records. A failing check exits 2. Inspection does not provision host
services, start containers, prompt for sudo, or change system configuration.

Doctor also inspects persisted workspace errors for the exact Sysbox startup
failure `namespace {"time" ""} does not exist`. When present, it reports a
failed Sysbox compatibility check with operator guidance. It does not infer the
failure from Docker, Sysbox or operating-system versions, and it does not edit
Docker daemon configuration or restart Docker. The JSON contract remains an
array of `{ "name": string, "ok": boolean, "detail": string }` records.

This is a prerequisite diagnostic, not proof of a successful workspace boot.
Creation separately validates runtime resources and waits for private Docker
readiness. Disposable-host verification exercises actual isolation and nested
container execution.

Optional integrations own their additional prerequisites and installation
checks. Host provisioning scripts install the runtime's system dependencies.
