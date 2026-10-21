# Execution Web plugin

`@slop-lab/dim-web-plugin-execution` provides recent CI jobs, result details,
bounded stdout/stderr, worker capacity and cancel/retry operations. The execution
scheduler still owns state transitions and worker authority.

Install alongside the exact matching `@slop-lab/dim-web` version and register the
plugin with private server-side configuration:

```json
{"queryConnection":"/absolute/ci-query.json","operatorConnection":"/absolute/execution-operator.json"}
```

The operator connection is optional. Connection files must be caller-owned,
mode-0600 regular files. Paths and credentials are never delivered to the
browser. Reading jobs requires `read`; capacity, cancel and retry require
`operator`. Retries include an explicit request UUID to avoid duplicate jobs.
