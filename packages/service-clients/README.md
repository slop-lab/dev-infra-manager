# Service clients

`@slop-lab/dim-service-client-*` packages are shared libraries for calling DIM
services. They run in their caller: a host plugin, Web server, or trusted service
plugin. They are not installation plugins and do not start the services they call.

| Package | Remote operations |
| --- | --- |
| [`execution`](execution/README.md) | Execution status, workers, cancellation, retries and scheduled task submission |
| [`llm-router`](llm-router/README.md) | Router administration and account/routing operations |
| [`native-git`](native-git/README.md) | Managed Git review, promotion and synchronization operations |

Wire schemas belong to `contracts`. The authoritative service enforces access;
these clients load their caller's private connection and validate requests and
responses without importing a host, Web or control-plane runtime.
