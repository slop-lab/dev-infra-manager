# Shared execution capacity

Sysbox and QEMU jobs use one optional execution service, queue, worker protocol
and capacity lifecycle. The installer keeps its `execution` deployment slot;
that slot is not a separate ordinary-only claim authority.

See [shared candidate execution](ci-runners.md) for worker setup, trusted profiles,
cleanup fencing and result publication. The base workspace application does not
load this service, interpret workflows or require CI for source readiness.
