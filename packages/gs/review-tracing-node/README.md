# @slop-lab/gs-review-tracing-node

Isolated JavaScript and erasable TypeScript review predicate execution for
`@slop-lab/gs-review-tracing`. The evaluator uses a pinned Node container with
no network, a read-only filesystem, an unprivileged user and bounded resources.
It imports no DIM host, control-plane, scheduler, registration or configuration
code. Embedding applications own runtime registration and task transport.

The execution host must provide Docker and pre-pull the reviewed image:

```sh
docker pull docker.io/library/node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df
```

Every evaluation creates a networkless, read-only container with a 128 MiB
memory limit, one CPU, 32 processes and a 15-second deadline. The container
receives no repository mount, Docker socket, host paths, operator credentials or
project environment. Cleanup verifies the exact execution name, ownership label
and container identity before removal.

Detector code reads repository content through the virtual `dim:review` module.
Include `@slop-lab/gs-review-tracing-node/review-api` in a detector project's
TypeScript `compilerOptions.types` for its declarations.

`readText(path)` reads detector code or configuration as a protected dependency.
`readTarget(path, view)` reads intended predicate input from the protected
`before` or candidate `after` snapshot. Relative JavaScript, JSON and erasable
TypeScript imports are tracked automatically. Built-in modules, packages,
network imports, native addons and arbitrary filesystem reads are unavailable.

Reads are bounded to 1 MiB per file, 4 MiB per execution and 128 requests.
Malformed messages, unsupported imports, incomplete reads, non-boolean results,
excessive output, cancellation and execution failures reject the evaluation.
