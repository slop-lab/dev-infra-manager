# Git review tracing libraries

These shared libraries support the Git repository host's optional review plugins.
They run in the process that imports them; neither package selects a host or
control-plane installation target.

| Package | Responsibility |
| --- | --- |
| [`@slop-lab/dim-git-review-tracing`](engine/README.md) | Track detector reads and compare dependency evidence |
| [`@slop-lab/dim-git-review-tracing-runtime-node`](runtimes/node/README.md) | Execute JS/TS detectors in isolated Node containers |

The [Git review plugin](../control-plane/plugins/git-review/README.md) owns review
and approval authority as an extension of the Git repository service. Its
[tracing plugin](../control-plane/plugins/git-review-tracing/README.md) supplies
tracked change matching. Execution is registered by the control-plane or host
`git-review-tracing-node` plugin; scheduled execution is connected by the
control-plane `git-review-tracing-scheduled` plugin.
