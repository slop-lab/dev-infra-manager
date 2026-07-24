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
pnpm --filter @slop-lab/dim-cli run check
pnpm --filter @slop-lab/dim-cli run test
pnpm --filter @slop-lab/dim-cli run build
```

## Smoke Gate

`just smoke` must cover:

- Docker agent image build.
- Secret runtime example image build.
- Agent image command smoke with inner Docker disabled.
- Sysbox agent execution with explicit outer CPU, memory, and PID limits.
- Exact cgroup v2 limit visibility inside the agent workspace.
- Nested Docker `hello-world` execution.
- Bidirectional image-store isolation using unique host-only and inner-only
  probe tags, independent of pre-existing image caches.
- Managed Git host initialization.
- Bare repo creation.
- Protected ref compatible initial seeding through trusted update-ref.
- Proposal branch push.
- PR create, approve, and merge.
- Secret runtime deploy from approved ref.
- Secret runtime `/healthz` check.

The smoke gate may use `directory` storage because it primarily checks Git/deploy integration in environments where loop setup may be unavailable.

## Fast Isolation Gate

`just isolation-check` must run without contacting Docker or creating a
container. It verifies generated runtime arguments, including:

- Outer CPU, memory, and PID limits.
- Job-specific workspace and nested runtime data mounts.
- Absence of the host `/var/lib/docker` as a mount source.
- Absence of the host `/var/run/docker.sock`.

`just isolation-check-json` runs the same tests with Vitest's JSON reporter so
CI can consume a single JSON document from stdout. These static checks do not
replace `just smoke`, which verifies actual Sysbox and cgroup behavior.

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
- Sysbox inner Docker can run nested `hello-world` without access to the host
  Docker image store.
- Sysbox exposes the outer agent CPU, memory, and PID cgroup limits to the
  nested workload as aggregate upper bounds.

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
