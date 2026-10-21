# Host execution worker

`@slop-lab/dim-host-plugin-execution-worker` executes configured CI jobs and installed task handlers on a Linux host. A single worker loop owns slot journals, lease renewal, cancellation and recovery. Its CI adapters own container/VM backends, bounded diagnostics and trusted Git snapshot acquisition. Task handlers own their task-specific execution and cleanup.

```sh
dim installer install plugin @slop-lab/dim-host-plugin-execution-worker@0.10.0
dim execution worker /absolute/private/worker.json
dim execution qemu-image local/ci-vm-runner:reviewed-tag
dim execution console describe --json
```

The worker configuration must be an owned mode-0600 file generated for the active control-plane generation. CI container slots require registered Sysbox; CI VM slots require functional KVM and a reviewed supervisor image. Task slots select an installed handler by task type and exact revision; they do not require Git or a CI runtime. Missing runtime prerequisites fail before claiming jobs. Installing or enabling this host plugin does not start a worker automatically.

The host composition supplies optional package-cache routing through a shared typed port. The worker has no dependency on a concrete mirrors plugin; direct access remains the default when no provider is configured.

The plugin also owns the controller's Execution console bridge used by Web UI.
After `dim control-plane connect SETUP`, it discovers the generated private
`ci-query.json` and optional `execution-operator.json` alongside the selected
host connection, checks their service/generation agreement and attests their
query/operator credentials. No Native Git host plugin is needed to use this
bridge. `dim execution console invoke OPERATION --expected-generation HASH
--input JSON --json` accepts only shared SDK operations and validated input;
raw credentials, connection paths and executable selection stay on the controller.
Installing the plugin exposes this bridge without starting a worker loop.

Only the exact selected repository snapshots are fetched and verified during trusted acquisition. Git sessions and credentials are disposed before job execution. Materialized files contain no Git credentials or repositories, and final live authorization checks fence stale dependencies and superseded attempts. The control-plane `execution-scheduler` plugin owns scheduling and lease authority; its CI integration owns CI admission and result publication.

Implement additional task handlers through
`@slop-lab/dim-contracts-execution/plugin-api`. The host plugin contributes an
`ExecutionTaskHandler` extension, and the worker resolves it from the host's
installed extensions. The wire schemas belong to execution contracts; the
scheduler implementation is not a handler dependency. The complete worker
configuration is exported from this package's `/config` entrypoint.
