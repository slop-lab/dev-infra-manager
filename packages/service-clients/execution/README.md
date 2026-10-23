# Execution client

`@slop-lab/dim-service-client-execution` is a shared caller-side library, consumed
by host plugins, Web plugins or trusted services. It does not register a plugin
or deploy the remote service.

`@slop-lab/dim-service-client-execution` provides typed remote clients for CI job queries,
bounded result diagnostics, worker capacity, cancellation and explicit retry.
It depends on wire contracts and the HTTP transport; it does not load host or
control-plane implementations. CLI default connection selection belongs to its
operator adapter; Web configuration supplies explicit absolute private paths.

```ts
import { createCiQueryClient, createExecutionOperatorClient } from '@slop-lab/dim-service-client-execution';
const jobs = await createCiQueryClient('/absolute/ci-query.json');
const operator = await createExecutionOperatorClient('/absolute/execution-operator.json');
await jobs.jobs();
await operator.workers();
```

Files must be caller-owned mode-0600 regular files, without symlinks or hardlinks.
Every request carries its selected generation and dedicated role credential.
Responses are bounded, schema-validated and never include worker leases or grants.
Retries require a caller-generated UUID request identifier for deduplication.

Trusted plugin task producers import `runScheduledTask` and `taskClientRevision`
from `@slop-lab/dim-service-client-execution/tasks`. The entry point submits a pinned
handler revision, mediates bounded exchanges through the caller's callback,
acknowledges cleaned results, and requests cancellation after an interrupted
session. It does not load the scheduler's SQLite store or execute a worker.
Task issuer credentials stay with the producer; its callbacks expose only the
operations explicitly supplied by that plugin.

Shared composed status schemas are exported by
`@slop-lab/dim-contracts-ci/query`; complete CI/task worker configuration is
exported by `@slop-lab/dim-contracts-ci/worker`. Consumers do not import a host
worker or control-plane service to validate those wire documents.
