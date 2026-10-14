# Overview

DIM owns a native Git control plane, persistent isolated workspaces, global
ordinary Sysbox and native QEMU capacity, and review-gated protected-ref
promotion. It does not own an issue tracker, hosted forge, Actions runtime, or
agent orchestration policy.

One Project has one reviewed root. A workspace materializes the protected-root
snapshot and receives only proposal-scoped write authority. Proposal pushes may
queue candidate-declared jobs on globally configured capacity. Results remain
candidate-controlled evidence. Human approval and checked promotion are
separate mandatory authority boundaries.

The product has no repository CRUD or Project purge surface. Additional source
repositories, if needed, are materialized by reviewed root lifecycle code and
remain outside native Project identity.
