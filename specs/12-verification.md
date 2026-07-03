# Verification

## Scope

This specification defines the minimum verification gates for development.

## Static And Unit Gates

`just verify` must run:

1. TypeScript check.
2. Unit tests.
3. Production build.

Current commands:

```bash
pnpm run check
pnpm run test
pnpm run build
```

## Smoke Gate

`just smoke` must cover:

- Docker agent image build.
- Secret runtime example image build.
- Agent image command smoke with inner Docker disabled.
- Managed Git host initialization.
- Bare repo creation.
- Protected ref compatible initial seeding through trusted update-ref.
- Proposal branch push.
- PR create, approve, and merge.
- Secret runtime deploy from approved ref.
- Secret runtime `/healthz` check.

The smoke gate may use `directory` storage because it primarily checks Git/deploy integration in environments where loop setup may be unavailable.

## Backend Verification

Runtime backend verification should include:

- `doctor --config` for the selected backend.
- `job run` lifecycle for at least a simple command.
- Nested container smoke when the backend claims nested Docker or Podman support.

Current verified host evidence:

- Rootless Podman with `directory` storage can run a full `job run` lifecycle.
- gVisor with `directory` storage can pass `doctor --config`.
- gVisor with `directory` storage can run a full `job run` lifecycle.
- gVisor inner Docker can run nested `hello-world`.

Sysbox remains blocked in the current nested host because `sysbox-mgr` cannot start and loop setup is denied.

## Install Verification

Host installation scripts must be verified by:

- Checksum verification for downloaded runtime artifacts.
- Runtime version command after installation.
- Docker runtime registration check when the script registers a runtime.

## Documentation Verification

When behavior changes:

- Update affected feature specs.
- Update local-details if command shapes, file formats, image entrypoints, or script behavior change.
- Update `docs/status.md` with new verified evidence.
- Ensure examples do not contradict protected-ref or secret-boundary invariants.
