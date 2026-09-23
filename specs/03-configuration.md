# Configuration

**Kind: Contract**

The local CLI consumes one strict schema-1 JSON file:

```json
{
  "schemaVersion": 1,
  "approvalRoot": "/home/operator/.local/state/dim/approvals",
  "broker": {
    "host": "control.example",
    "user": "dim-broker",
    "port": 22,
    "identityFile": "/home/operator/.config/dim/id_ed25519",
    "knownHostsFile": "/home/operator/.config/dim/known_hosts",
    "timeoutMs": 10000,
    "maxResponseBytes": 65536
  },
  "workloads": {
    "unit-tests": ["/usr/local/libexec/dim/unit-tests"]
  }
}
```

All local paths are absolute. The operator provisions the private key and a
pinned host-key entry out of band. DIM does not create keys, modify
`authorized_keys`, accept `StrictHostKeyChecking=accept-new`, or infer trust
from DNS.

Workload commands are local policy. The broker transmits only workload IDs.
Configuration schema changes are rejection-only during the pre-stable period
unless a future specification defines an explicit migration.

The optional remote control plane accepts
`DIM_CONTROL_PLANE_PROPOSAL_FILE`, an absolute path to its provider-generated
schema-1 proposal queue fixture. Production queue and provider configuration
belongs to `@slop-lab/dim-control-plane`, never to the local core package.
