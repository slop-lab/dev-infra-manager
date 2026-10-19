# Threat model

Development code can execute arbitrary commands, install packages, mutate all
files in its workspace, start nested containers and use the workspace's network
access. It is untrusted by the host. The administrator, DIM host process, host
Docker daemon, selected runtime and workspace image form the trusted computing
base.

The base boundary protects the host filesystem, host runtime controls, operator
credentials, and data belonging to other workspaces from accidental exposure
through DIM configuration. The agent container uses unprivileged Sysbox and
private volumes. DIM does not give it host bind mounts, devices, the host Docker
socket, or operator credential files. Nested Docker uses its own persistent
engine store.

The agent can become root within its own container. Its container root does not
therefore grant host administrative authority. Isolation depends on Linux and
the selected runtime behaving correctly. DIM does not promise hostile-tenant
security, network egress filtering, protection against kernel vulnerabilities,
or confidentiality from a host administrator. Published workspace services and
credentials that the user explicitly supplies have their own access policy.

Managed Git and secret-bearing services introduce additional assets and trust
boundaries. Their policies belong to the optional managed integration and must
not be inferred for an ordinary Git workspace. See the managed package's
[trust boundaries](../../packages/host/core/docs/trust-boundaries.md).
