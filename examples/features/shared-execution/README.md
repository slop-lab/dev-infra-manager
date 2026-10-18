# Shared Sysbox and QEMU workers

Prepare/install/connect the optional control plane as described in
[managed administration](../../../core/packages/managed/docs/cli.md). Edit the
private execution service configuration before deployment to add a worker and
its slots. Each slot selects `container` or `vm` plus reviewed image digests and
resource bounds. A worker may serve jobs from multiple Projects.

For each slot, the service profile contains:

```json
{
  "id": "build-1",
  "runtime": "container",
  "profile": {
    "runnerBaseImage": "registry.example/sysbox-runner@sha256:REVIEWED_DIGEST",
    "jobBaseImage": "registry.example/project-tools@sha256:REVIEWED_DIGEST",
    "bounds": {
      "cpu": "2", "memoryBytes": "536870912", "pids": "128",
      "wallClockSeconds": "300", "outputBytes": "16777216"
    }
  }
}
```

Replace both placeholder digests. The worker's service entry has a unique `id`,
private `token` and `slots` array. Pair its host file with the same ID/token and
slot identities; the host file is owner-only mode `0600`:

```json
{
  "schemaVersion": 1,
  "workerId": "worker-a",
  "generationId": "INSTALLED_64_HEX_GENERATION",
  "stateDirectory": "/srv/dim/worker-a",
  "gitExecutable": "/usr/bin/git",
  "endpoint": "https://ci.example.test",
  "nativeGitEndpoint": "https://git.example.test",
  "token": "DISTINCT_PRIVATE_WORKER_TOKEN",
  "slots": [{ "id": "build-1", "runtime": "container" }]
}
```

Use actual authenticated HTTPS origins or loopback HTTP via an operator-owned
forward. Start it on that runtime host:

```bash
dim --host devbox managed ci worker /srv/dim/worker-a.json
```

A QEMU slot uses the same shape with `runtime: "vm"`. Its runner image is the
trusted QEMU supervisor built with `dim managed ci qemu-image IMAGE:TAG`; its job
image supplies the guest root and reviewed tools. That host requires functional
KVM. Hardware absence does not enable a fallback.

A repository selects jobs through the workflow plugin's configuration, for
example the [native Project fixture](../../projects/native-basic-root/README.md).
The candidate does not choose worker profiles. Proposal pushes queue valid
jobs automatically; protected review policy selects required results. Results
remain candidate-controlled, with human approval and protected promotion
separately authorized.
