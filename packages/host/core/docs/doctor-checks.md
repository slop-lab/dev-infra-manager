# Host diagnostics

`dim doctor` checks the selected host's base workspace runtime and reports
concrete missing prerequisites. Native Git connectivity, CI worker slots and
shared-service configuration belong to their owning plugins or operator tools.
The base diagnostic does not require a control plane or repository workflow.
It also reports an exact recorded Sysbox time-namespace startup failure from
workspace state without starting another container. This recognition is based
on the runtime error itself, not a version combination. DIM does not change
Docker daemon settings or restart host services.

See [runtime backends](../../../../docs/guides/runtime-backends.md) and the
[host installation guide](../../../../docs/development/host-install-readiness.md)
for environment setup. The CI worker validates its configured Docker or KVM
backend before accepting execution work.
