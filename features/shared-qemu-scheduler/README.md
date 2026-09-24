# Shared QEMU scheduler

This example shares QEMU CI demand across two DIM hosts without sharing host
runtime authority. It requires one external Gitea service and a deployed
standalone scheduler. Each host still starts, stops, and reaps only its own
supervisor and VM processes.

Build a version-pinned image from the installed DIM CLI:

```bash
dim ci scheduler image build registry.example/dim-qemu-scheduler:0.9.0
```

Copy `service-config.json` to `config.json`, replace every placeholder, make it
owned by UID 10001, and set mode `0600`. Run the image with the file at
`/var/lib/dim-scheduler/config.json` and the containing directory on a durable
volume. Terminate TLS in front of the service unless all traffic is confined to
an explicitly isolated network.

Keep `leaseSeconds` at 60 or greater and set `allowedLabels` to the reviewed
QEMU integration labels for the Project. Host tokens may only replay queued
demand using those labels; only the webhook token may advance jobs to running
or completed. A 20-second takeover grace and restart hold provide time for
ordinary local cleanup, but they cannot externally fence a host paused or
partitioned beyond that bound. Deploy infrastructure fencing separately when
that failure model must be covered.

On each DIM host, copy `host-connection.json` to a private file, use a distinct
stable `hostId` and matching token, set mode `0600`, and export its path:

```bash
export DIM_QEMU_SCHEDULER_CONNECTION_FILE="$HOME/.config/dim/qemu-scheduler.json"
dim ci runner create acme integration-a qemu
```

The `projectId` must equal the existing DIM Project ID on every host. Configure
Gitea's organization `workflow_job` webhook with the exact `webhookUrl` and
`webhookToken`. Do not put Gitea administrator credentials in either file.
Leaving the environment variable unset uses the existing host-local scheduler;
DIM rejects mixing local and shared modes for one Project.
