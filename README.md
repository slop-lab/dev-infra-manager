# dev-infra-manager

`dev-infra-manager` provides infrastructure for running AI-assisted development jobs in isolated, review-gated environments.

The project focuses on the container and infrastructure boundary around agent jobs:

- Ephemeral agent workspaces.
- Sysbox-based nested container isolation.
- Secret-bearing runtime separation.
- Review-gated deployment of secret-bearing environments.
- Managed Git hosting primitives for proposed changes.
- Job-level resource limits, including aggregate disk quota.

See [docs/README.md](docs/README.md) for the full documentation index.
