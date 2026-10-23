# CLI/host transport protocol

The `dim.cli-host` version 1 envelope is independent of DIM package versions.
The client negotiates supported wire versions, forwards command arguments without
interpreting host features, and preserves stdout, stderr and exit status. Only
capabilities and workspace endpoint discovery return transport JSON. Workspace
TCP connections pin the discovered immutable workspace ID.

Unknown wire versions fail before command dispatch. Package versions remain
exactly pinned at installation; compatible CLI and host releases can run together.
The retained [v1 specification](../../../docs/specs/cli-host-protocol-v1.md) defines
the compatibility promise. This package contains no host, installer or feature
implementation.
