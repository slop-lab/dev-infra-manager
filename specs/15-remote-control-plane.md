# Remote Control Plane

**Kind: Contract**

## Package boundary

`@slop-lab/dim-core` contains provider-neutral DTO parsing, local approval and
admission, bounded SSH polling, and workload-ID execution. `@slop-lab/dim-cli`
depends only on that package and Commander. Neither package imports, reexports,
or installs provider implementation code.

`@slop-lab/dim-control-plane` is separately publishable and optional. Managed
Gitea, Actions coordination, and provider adapters live there. A Gitea Actions
connector may run inside an approved sandbox, but is not a local host package
dependency.

## Protocol

A poll request contains only `schemaVersion`, `requestId`, and `projectId`. A
proposal contains those identities plus `workloadId`, a complete tree, and
capability names. Every object is exact: unknown and missing fields fail.

The complete tree lists every path, kind, mode, and content digest. Its
aggregate SHA-256 is calculated over the canonical path-sorted entry stream.
Admission requires equality with the locally approved aggregate digest. It
also requires every path to match an approved pattern and every capability to
be within the approved ceiling. Symlinks, gitlinks, `.gitmodules`, absolute or
traversing paths, duplicate authority, and capability widening are rejected.

## Transport

The local SSH process executes exactly `dim-control-plane broker stdio`. It
uses an explicit identity, pinned known-hosts file, strict host-key checking,
batch mode, no forwarding, no agent, no PTY, no local command, a timeout, and a
response byte ceiling. It never tunnels an HTTP or Unix admin socket.

## Approval and state

Approval is an explicit local operator action over the full aggregate tree,
path patterns, and capability ceiling. Schema-1 records are mode `0600` under
a mode `0700` root. Unsupported schemas fail closed with export-and-recreate
guidance; there is no compatibility shim.
