# Scheduled TypeScript review execution

This recipe demonstrates dispatching a repository detector through DIM's shared
execution scheduler. The repository owner uses `review-tracing-scheduled`, the
scheduler service uses `execution-scheduler`, and the execution host installs `execution-worker` plus
`review-tracing-node`. These exact plugins are declared in `recipe.json`.
The scheduler may run separately from the repository-owning control plane and
the execution host. Configuration, worker registration, handler revision pins
and private task credentials are described in the
[scheduled runtime guide](../../../packages/control-plane/plugins/git-review-tracing-scheduled/README.md).

The repository template contains `guard/main.ts`, its relative TypeScript helper
and `app.json`. The detector compares the `runtime.isolation` field between two
snapshots. The repository owner serves requested bytes and records dependencies;
the host runs the detector in a disposable Docker container without a repository
mount. The scheduler forwards bounded exchange messages and owns task leases.
It does not interpret the detector or grant repository promotion authority.

This recipe exercises runtime dispatch and dependency accounting. It does not
install Native Git or perform protected-ref approval; see the
[review-tracing recipe](../review-tracing/README.md) for that complete workflow.
To use this adapter with managed review, also install that recipe's repository,
code-review, merge-policy and review-tracing integrations on the repository
owner, selecting `runtime: "node-scheduled"`.

Check the detector's types independently from execution:

```bash
cd repository
npm install
npm run check
```

The template pins the virtual API type package and TypeScript. Its strict
configuration rejects syntax that needs TypeScript code generation. Runtime
type stripping itself does not check types or install project dependencies.

From the DIM repository root, run ordinary verification:

```bash
node scripts/examples/run.ts examples/features/scheduled-review verify
```

This checks the recipe, its standalone TypeScript configuration, authenticated
HTTP task dispatch, lease renewal, cancellation, cleanup, slot reuse and
repository path validation. It uses a deterministic handler instead of Docker.
For the actual template execution, pull the pinned image on the execution host:

```bash
docker pull docker.io/library/node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df
node scripts/examples/run.ts examples/features/scheduled-review dev
```

The live check loads this recipe's repository files, uses a separate HTTP
scheduler listener and the installed host handler, and runs TypeScript in real
Docker. The scheduler, issuer and worker harness share one OS process in this
test; the detector has a separate container. This validates the transport and
execution path without claiming a test across separate physical hosts or VMs.
