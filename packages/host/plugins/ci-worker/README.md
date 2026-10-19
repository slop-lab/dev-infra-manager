# Host CI worker

`@slop-lab/dim-host-plugin-ci-worker` executes explicitly configured CI slots on a Linux host. It owns container/VM backends, bounded diagnostic collection, trusted Git snapshot acquisition and cleanup journals. It contains no CI coordinator database or Git authority service.

```sh
dim installer install plugin @slop-lab/dim-host-plugin-ci-worker@0.10.0
dim ci worker /absolute/private/worker.json
dim ci qemu-image local/ci-vm-runner:reviewed-tag
```

The worker configuration must be an owned mode-0600 file generated for the active control-plane generation. Container slots require registered Sysbox; VM slots require functional KVM and a reviewed supervisor image. Missing runtime prerequisites fail before claiming jobs. Installing or enabling this host plugin does not start a worker automatically.

The host composition supplies optional package-cache routing through a shared typed port. The worker has no dependency on a concrete mirrors plugin; direct access remains the default when no provider is configured.

Only the exact selected repository snapshots are fetched and verified during trusted acquisition. Git sessions and credentials are disposed before job execution. Materialized files contain no Git credentials or repositories, and final live authorization checks fence stale dependencies and superseded attempts. A separate control-plane CI plugin owns admission, worker authority and result publication.
