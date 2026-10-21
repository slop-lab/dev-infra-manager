# Execution client

`@slop-lab/dim-execution-client` provides typed remote clients for CI job queries,
bounded result diagnostics, worker capacity, cancellation and explicit retry.
It depends on wire contracts and the HTTP transport; it does not load host or
control-plane implementations. CLI default connection selection belongs to its
operator adapter; Web configuration supplies explicit absolute private paths.

```ts
import { createCiQueryClient, createExecutionOperatorClient } from '@slop-lab/dim-execution-client';
const jobs = await createCiQueryClient('/absolute/ci-query.json');
const operator = await createExecutionOperatorClient('/absolute/execution-operator.json');
await jobs.jobs();
await operator.workers();
```

Files must be caller-owned mode-0600 regular files, without symlinks or hardlinks.
Every request carries its selected generation and dedicated role credential.
Responses are bounded, schema-validated and never include worker leases or grants.
Retries require a caller-generated UUID request identifier for deduplication.
