# Workspace resources

The base runtime uses one unprivileged Sysbox agent container. CPU, memory and
PID limits cover it and its descendants, including its private Docker daemon
and nested containers. There is no required outer trusted container or budget
split in this path.

```bash
dim create /srv/app dev --cpus 2 --memory 4g --pids 2048
dim resources dev --memory 8g
dim resources dev --cpus unlimited --memory unlimited --pids unlimited
```

Omitted values preserve the recorded setting. Positive values and explicit
`unlimited` are accepted. Live changes are read back before success is recorded.
Removing a Docker limit uses keep-data recreation and reports that outcome;
zero-valued updates do not reliably clear existing Docker limits. Failed changes
attempt to restore the previous settings and report failure rather than promise
an uncertain effective limit.

Checkout, home and private Docker data live in separate owned volumes. Stop,
start and recreate preserve them. Initialized records with missing data fail
without silently creating replacements. Discard is the explicit destructive
operation. There is no per-workspace disk quota; Docker data can consume host
storage. The administrator remains responsible for host capacity.

Runtime observations do not overwrite persisted lifecycle state. `dim ls` and
`dim show` expose missing, stopped or unavailable runtime observations separately
from a recorded running phase.

Managed Git uses the same runtime and resource accounting. Its optional host
Git broker is scoped service infrastructure; it does not add an outer workload
container or split the workspace budget.
