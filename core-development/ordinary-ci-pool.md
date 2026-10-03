# Ordinary CI pool (staged operator path)

This path pools **ordinary Sysbox** capacity across dynamically admitted, reviewed DIM
Projects and hosts attached to the same external Gitea control plane. It does
not pool QEMU integration runners or create a Gitea instance runner. It is not
an automatic migration of Project-scoped runners. Do not enable it on a live
host until the live two-host Gitea/Sysbox gate in
`specification/specs/12-verification.md` has been run and reviewed.

## Trust and migration preflight

1. Use one reviewed external Gitea service and explicit Project bindings on
   **each** participating host. The binding ID, `gitNamespace`, and
   `giteaOrganizationId` must match the central enrollment, even if that host
   has no local Project record. Do not enroll an unrelated organization or
   grant a job the Gitea administrator credential.
2. Select one reviewed, digest-pinned disposable job image shared by every
   Project. Each Project's protected `.dim/ci/runner.yml` supplies its ordinary
   labels and must select exactly that image. The existing
   Project-specific runner configuration and QEMU hook/cache remain separate;
   pooled jobs do not select the old Project-specific ordinary image.
3. Stop and delete conflicting legacy Project-scoped Sysbox runners on all
   hosts before enabling the pool. Do not run both modes as a way to add
   capacity. Keep existing QEMU runners in place.
4. Supply a private, persistent SQLite database on the control-plane host.
   Retain it across service restarts. Back up the database together with its
   write-ahead-log files using SQLite-safe backup procedures, not a live file
   copy. The database has a strict schema version; schema-less and unsupported
   databases are rejected unchanged without implicit migration. Run the service
   behind an operator-controlled HTTPS endpoint (or an explicitly isolated
   network); do not publish its tokens to workspaces.
5. Run `dim ci ordinary-pool project reconcile PROJECT REGISTRAR_CONFIG` on a
   trusted host before the admission lease expires and after protected policy
   changes. It resolves the exact protected root commit, validates the external
   Gitea binding and live organization ID, admits the reviewed config, installs
   the service-owned stable organization webhook secret, and replays queued
   jobs. Never run this command in a workspace or worker process.

## Private configuration

The service config is a JSON file owned by its DIM operator user with mode
`0600`, without symlinks. Example values are placeholders, not credentials:

```json
{
  "schemaVersion": 2,
  "listen": { "host": "127.0.0.1", "port": 7410 },
  "serviceId": "ordinary-main",
  "database": "/var/lib/dim/ordinary-pool.sqlite3",
  "jobImage": "registry.example/dim/ordinary@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "webhookBaseUrl": "https://pool.example",
  "registrarToken": "replace-with-private-registrar-token",
  "admissionLeaseMilliseconds": 300000,
  "hosts": [
    { "hostId": "host-a", "token": "replace-with-private-host-token-a", "capacities": ["primary"] },
    { "hostId": "host-b", "token": "replace-with-private-host-token-b", "capacities": ["primary"] }
  ]
}
```

Start the trusted service as `dim ci ordinary-pool service run FILE` under a
service manager with restricted access and normal restart supervision. Each
host needs `DIM_GITEA_CONNECTION_FILE` pointing at its reviewed external Gitea
connection and `DIM_ORDINARY_CI_POOL_CONNECTION_FILE` pointing at its own
mode-`0600`, DIM-user-owned JSON file:

```json
{
  "schemaVersion": 2,
  "transport": "https",
  "endpoint": "https://pool.example",
  "hostId": "host-a",
  "token": "replace-with-private-host-token-a",
  "expectedServiceId": "ordinary-main",
  "expectedJobImage": "registry.example/dim/ordinary@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
}
```

The trusted registrar uses a different mode-`0600` file. Do not mount it into
the service or worker:

```json
{
  "schemaVersion": 1,
  "transport": "https",
  "endpoint": "https://pool.example",
  "token": "replace-with-private-registrar-token",
  "expectedServiceId": "ordinary-main",
  "expectedJobImage": "registry.example/dim/ordinary@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
}
```

Use `transport: "loopback-http"` only for loopback HTTP, or
`transport: "isolated-http"` only on a genuinely isolated, reviewed network.
The external Gitea connection `hostId` must equal this file's `hostId` and
its `projects` bindings must include every Project the host may claim.
Provision the reviewed Sysbox runner host image and `dim-control` network on
each host. Start one supervised `dim ci ordinary-pool worker serve CAPACITY`
per listed capacity; `worker run-once CAPACITY` processes at most one claim
for a controlled verification run. Neither command should run in an agent
container. Inspect actual Docker runtime, limits, mounts and Gitea workflow
results before calling the migration complete. The worker reconciles the
host-scoped registry cache before taking a claim and passes a read-only nested
Docker mirror configuration to each ephemeral runner. An unavailable cache
must fail the job without a direct Docker Hub bypass.

An expired lease fences that host capacity until its next worker run has
inspected and reaped the exact DIM-owned container and acknowledged recovery.
Do not delete the database or reuse a host ID to bypass this fence. A foreign
container name or failed cleanup is an operator incident, not permission to
force a new claim. A job completed by Gitea may be delivered again; verify
results at the coordinator, not solely from the pool's `completed` claim
output. The service's `/healthz` endpoint is process health, not evidence of
webhook installation or available workers.

Queued jobs and claims retain a fresh random public admission generation ID
bound to the reviewed service, Project, protected ref/commit/config digest,
common image, and labels in effect when the webhook was accepted. Tokens are
excluded. An active identical-policy reconcile refreshes the lease without
changing that generation. Expiry, revocation, or changing any bound identity
requires a new generation, even if a later reconcile restores identical policy
bytes, so old queued demand remains inactive. An expired old claim still
requires host cleanup, but its recovery acknowledgement does not requeue it
under the replacement generation. Submit a fresh authenticated webhook event
to create demand for the new admission ID.

## Disposable-QEMU verification

After the reviewed Project enables its trusted QEMU verification socket,
`node project/.dim/qemu-client.mjs run` snapshots the current assembled tree,
installs DIM and Sysbox in a disposable Ubuntu guest, then runs
`just verify ordinary-ci-pool-live` before the other guest checks. Inside an
already provisioned Sysbox guest, run that recipe directly. It creates an
isolated Gitea service and real organization webhooks, then verifies that
`host-b` runs `dim-alpha`'s workflow and `host-a` runs `dim-beta`'s workflow,
each with no local Project record. It inspects the runtime, cgroup limits,
mounts, devices and pull-through cache and removes only its disposable fixture
resources. The two host identities use the **same guest Docker daemon**:
success is not the required independent two-physical-host failover gate.
