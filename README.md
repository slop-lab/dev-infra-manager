# dev-infra-manager

`dev-infra-manager` provides infrastructure for running AI-assisted development jobs in isolated, review-gated environments.

The project focuses on the container and infrastructure boundary around agent jobs:

- Ephemeral agent workspaces.
- Sysbox-based nested container isolation.
- Secret-bearing runtime separation.
- Review-gated deployment of secret-bearing environments.
- Managed Git hosting primitives for proposed changes.
- Job-level resource limits, including aggregate disk quota.

## Quick Start

Install dependencies and verify the TypeScript project:

```bash
pnpm install
just verify
```

Install host runtime dependencies on Ubuntu:

```bash
just install-host-ubuntu
```

Or run the full Ubuntu bootstrap:

```bash
just bootstrap-ubuntu
```

Create a local configuration:

```bash
just sample-config
```

Build the included runtime images:

```bash
just build-agent-image
just build-secret-example
```

Run the reproducible integration smoke test:

```bash
just smoke
```

Inspect host readiness:

```bash
just doctor
```

Prepare an agent job filesystem without making host changes:

```bash
pnpm run cli -- job prepare --config config.example.json --job-id demo --dry-run
```

Run a full agent job lifecycle:

```bash
pnpm run cli -- job run --config config.example.json --job-id demo -- bash
```

Run the deploy controller once in dry-run mode:

```bash
pnpm run cli -- controller run --config config.example.json --once --dry-run
```

See [docs/README.md](docs/README.md) for the full documentation index.
