# Host diagnostics

`dim doctor` checks the selected host's base workspace runtime and reports
concrete missing prerequisites. Native Git connectivity, CI worker slots and
shared-service configuration belong to their owning plugins or operator tools.
The base diagnostic does not require a control plane or repository workflow.

See [runtime backends](../../../../docs/guides/runtime-backends.md) and the
[host installation guide](../../../../docs/development/host-install-readiness.md)
for environment setup. The CI worker validates its configured Docker or KVM
backend before accepting execution work.
