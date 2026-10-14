# Architecture

The native Git service owns registered root identity, protected refs, proposal
namespaces, immutable review tuples, terminal evidence, human approval, and
checked promotion. A host controller owns Project/workspace state and runtime
dispatch. Workspaces receive only scoped broker grants, never admin sockets or
raw service credentials.

Ordinary CI owns durable global Sysbox demand, claims, and result delivery.
Native QEMU uses a separate scheduler, host token, claim journal, and KVM
supervisor. Neither scheduler can review or promote. The candidate receives no
host runtime socket, `/dev/kvm`, registrar, reviewer, promoter, scheduler, or
result-reporter credential.

Readiness, CI quality, and security approval are independent state. Promotion
requires exact current approval and policy-selected evidence, then performs an
atomic old-object-ID update.
