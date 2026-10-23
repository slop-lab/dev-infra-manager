# Node runtime for Git review tracing

`@slop-lab/dim-git-review-tracing-runtime-node` supplies isolated JavaScript and TypeScript
review detector execution, shared by local control-plane and scheduled host
plugins. The package does not depend on either core. It is a shared library; operators
select the host or control-plane `git-review-tracing-node` plugin, which registers
this runtime in that installation.

The execution host operator must provide Docker and pull the exact reviewed image
before serving requests:

```sh
docker pull docker.io/library/node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df
```

The runtime never pulls an image during detector execution. Every evaluation
creates an unprivileged, networkless, read-only container with a 128 MiB memory
limit, one CPU, 32 processes and a 15-second execution deadline. The container
receives no repository mount, Docker socket, host paths, operator credentials or
project environment. Cleanup verifies the invocation's unique container name
and ownership label before removing its exact identity. If Docker creates the
container but its CLI fails before returning that identity, cleanup recovers it
using both ownership selectors and verifies it again before removal.

## Detector API

A repository entrypoint exports `matches(changes)`, returning a boolean or a
promise of one. The `changes` argument contains changed path/status metadata.
Content reads use the virtual `dim:review` module:

```js
// @ts-check
import { readText, readTarget } from "dim:review";
import { securityChanged } from "./security-fields.mjs";

const configuration = JSON.parse((await readText("review/settings.json")) ?? "{}");
export async function matches() {
  const before = await readTarget(configuration.path, "before");
  const after = await readTarget(configuration.path, "after");
  return securityChanged(before, after);
}
```

`readText(path)` reads the candidate's file as a detector dependency.
`readTarget(path, view = "after")` reads detector input from the protected
(`before`) or candidate (`after`) snapshot. Missing files return `undefined`.
All paths are normalized, repository-relative exact paths. The host broker
validates requests, reads Git snapshot data and records content digests; it
does not accept a candidate-produced dependency manifest.

The entrypoint and relative static/dynamic ESM imports are dependencies
automatically. JSON module imports are dependencies too. Imports require exact
file paths; package resolution, built-in modules (including `node:fs`), native
addons, network imports and arbitrary filesystem reads are unavailable. Use
`readText` for configuration that can change detector behavior. Use `readTarget`
only for the data whose changes the detector is intended to classify. A target
read cannot remove another dependency read of the same path.

For strict editor/type checking, include
`@slop-lab/dim-git-review-tracing-runtime-node/review-api` in the
project's TypeScript `compilerOptions.types`. It declares the virtual module;
the module itself is supplied only inside the detector runner.

## TypeScript detectors

Entrypoints and relative imports can use `.ts` or `.mts` with erasable TypeScript
syntax. Import exact paths, including the extension:

```ts
import { readTarget, type ReviewChange } from "dim:review";
import { securityChanged } from "./security-fields.ts";

export async function matches(changes: readonly ReviewChange[]): Promise<boolean> {
  return changes.length > 0 && securityChanged(
    await readTarget("app/config.json", "before"),
    await readTarget("app/config.json", "after")
  );
}
```

The guest loader strips types after the host records the original source bytes.
Type-only imports are erased and do not become runtime dependencies. Runtime
imports, including TypeScript helpers, remain automatically tracked. Use
`import type` or inline `type` explicitly for types.

Run `tsc --noEmit` with `strict: true`, `verbatimModuleSyntax: true` and
`allowImportingTsExtensions: true` in project validation. Type stripping does
not check types. The runtime does not read `tsconfig.json`, resolve npm packages,
rewrite import paths or transpile CommonJS/JSX. Enums, parameter properties and
other syntax requiring generated JavaScript fail the evaluation. The pinned
Node image supplies the [type stripping API](https://nodejs.org/download/release/v22.14.0/docs/api/module.html#modulestriptypescripttypescode-options).

This runtime deliberately uses a brokered API rather than syscall observation.
There is no untracked repository filesystem in the container. The loader routes
module dependencies through that same broker. The VM context restricts the
supported module API; Docker provides process containment. This is not a claim
that Node's VM isolates hostile code on its own.

Reads are bounded to 1 MiB per file, 4 MiB per execution and 128 requests.
Malformed messages, unsupported imports, a missing module, incomplete reads,
non-boolean results, excessive output, cancellation and execution failures reject
the evaluation. The runtime revision binds the installed host implementation,
guest runner and pinned image. The shared tracing package owns review policy and
manifest enforcement; this plugin only supplies one language runtime.

Run the opt-in real Docker tests from `tests/`:

```sh
DIM_TEST_REVIEW_TRACE_DOCKER=1 pnpm exec vitest run scenarios/harness/traceNodeRuntime.test.ts
```


`createNodeReviewTraceRuntime({ ownerId })` optionally binds disposable resources
to a journaled execution UUID. `cleanupNodeReviewTraceExecution(ownerId)` recovers
only the exact container name and ownership label for that execution. The host
task handler uses these APIs so restarting the common worker cleans abandoned
resources before its slot can accept another task. Local executions omit the
owner ID and receive a fresh random identity.
