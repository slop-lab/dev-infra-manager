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

## Explicit Ubuntu hardware runner

`dim execution qemu-image IMAGE --profile ubuntu-hardware [--ubuntu-image ABS]`
builds a separate trusted Ubuntu 24.04/systemd runner. The Ubuntu cloud image
must match SHA-256 `6a81c37564db9b1ee84e141922625e1d7c5b389b99bb3c572e0243607d5bb4d2`;
by default the builder reads the existing DIM artifact cache. An operator may
provide the same verified bytes from a mirror using `--ubuntu-image`.

Enroll a dedicated `vm` slot explicitly. Its runner and job image must be the
**same immutable digest**, with at least four CPUs, 20 GiB memory and a 10800-second
wall budget. The worker state directory needs at least 80 GiB free on a disk
filesystem. The profile creates a private 24 GiB root overlay and a separate
64 GiB scratch disk; scratch backs guest `/tmp`, rather than RAM tmpfs. The
operator image label selects this mode, not a candidate environment variable.
Ordinary Sysbox and the existing small QEMU runner retain their behavior.

The supervisor stays unprivileged, has only KVM and exact owned job/workspace/
private disk mounts, and exposes no Docker socket or reusable host credentials.
This profile provides temporary emergency operator SSH by default, through an
ephemeral port published only on the selected execution host's loopback.
Inside the full disposable guest, the job has normal sudo so it can provision
nested disposable machines. A fresh non-root guest process must successfully
create and close a nested KVM VM before the job starts. CPU/memory and supervisor
PID limits remain host-enforced; the guest job unit also has `TasksMax`. Guest
root can manage its own systemd units, but acquires no host authority.

The copied candidate runs from a disk filesystem. Only the job descriptor/config
mount is read-only; evidence is written through the dedicated
`/workspace/.dim-ci-artifacts` share, including on failure. The hypervisor disks
are outside that share. A private virtio exit channel preserves the actual job
exit status and must agree with the VM termination signal. Building/enrolling
this profile does not itself qualify any source commit or run a hardware gate.
## Emergency access to a running hardware verification VM

The worker requires the normal host OpenSSH client tools (`ssh` and
`ssh-keygen`). Each hardware attempt creates a fresh login key and separate
fresh guest server key beneath its owned mode-0700 `hardware` directory. Only
the login public key enters the guest; its private key is never in the job,
workspace or tools shares. Cloud-init replaces image SSH host keys with the
fresh server identity. Password/root login and agent forwarding are disabled.
The new image is identified by `ubuntu-hardware-v2`; earlier v1 images are
rejected because they do not provide this access contract. Rebuild the trusted
image normally and select its reviewed immutable digest. SSH starts before APT/bootstrap, so an operator can investigate a stalled
bootstrap as well as a running job. It remains subject to the ordinary job
lease, deadline and exact cleanup; access does not keep a failed job alive.

Use the normal selected host to discover the endpoint for an exact execution:

```bash
dim --host devbox execution worker ssh-info --config /absolute/private/worker.json \
  --execution 00000000-0000-0000-0000-000000000001 --json
```

The response contains `sshConfig` and a command array, never key contents or
worker credentials. Discovery checks the current worker assignment, private
root identity, exact owned running supervisor and its sole host-loopback port.
Run the returned `ssh -F ABS_PRIVATE_SSH_CONFIG dim-verification` **on that
execution host**. For a remote host, use its existing operator transport, for
example `ssh -t devbox -- ssh -F ABS_REMOTE_SSH_CONFIG dim-verification`; the
local machine cannot use a private key or loopback port that exists remotely.
No new interactive CLI–host protocol is needed. The generated configuration
pins the fresh server key with `StrictHostKeyChecking yes` and disables agent
forwarding. Do not copy the key into a workspace, disable host-key checking or
publish the port publicly.

Docker publishes `127.0.0.1::2222/tcp` on the real execution host; QEMU forwards
the supervisor's port2222 to guest22. Container loopback alone would not be
reachable through that host publication. Host/none supervisor networks are
rejected for this profile. Normal exact attempt cleanup removes its supervisor
port, private keys and SSH configuration together. An ended or changed attempt
is unavailable, even if historical discovery output remains. Small QEMU and
Sysbox do not gain SSH listeners.

The separate baseline/examples guest bootstrap already creates fresh login and
host keys and a pinned host-loopback SSH forward per owned role VM. Its trusted
`BOOTSTRAP_SSH`/`BOOTSTRAP_SCP` arrays and private role root are the corresponding
access path when operating that fixture directly; those inner ports are local
to its owning outer verification guest, not public host ports.

## Durable execution artifacts

CI backends spool the complete accepted stdout/stderr within the reviewed output bound, alongside existing64KiB diagnostics. Jobs opt into file capture by writing regular files below the fixed `DIM_ARTIFACTS_DIR=/workspace/.dim-ci-artifacts`; they appear as `files/<relative-path>`, with reserved `logs/stdout.log` and `logs/stderr.log`. Symlinks, special files, changed files, traversal and oversized collections are rejected. Limits are128files,128MiB/file and256MiB/job.

After backend cleanup stops untrusted writers, capture copies bytes into a private pending directory outside the runtime root. The durable worker journal records the completed command before lease-bound chunk upload; uncertain upload restarts reuse those bytes without executing candidate code again. The private runtime root is cleaned even when upload is interrupted. Artifact availability is independent of command success: capture errors are explicit and already captured valid diagnostics remain downloadable. No host keys, user homes or arbitrary configured paths are swept into artifacts.

Upload has a five-minute worker-owned deadline persisted in the journal; a worker
restart cannot grant a fresh budget. Healthy lease renewals continue during the
bounded upload and exact owned cleanup. A storage outage beyond the deadline
reports `artifact-upload-timeout` as an executor failure, preserving command
diagnostics and preventing a successful CI claim. The slot becomes reusable only
after that failure is accepted. The private `artifacts-<execution UUID>` directory
retains its immutable bytes, manifest and token-free `upload-timeout.json` with
the original command result for operator recovery; it is not silently deleted or
reexecuted. `dim-ci logs` clearly labels diagnostic-prefix fallback and the failure
reason when retained remote logs are unavailable.

Trusted acquisition failures retain a bounded JSON stderr diagnostic with an enumerated
phase and failure code (credentials, protected-head checks, fetch, object verification
or materialization). Initial credential failure follows the same failed-result and
artifact cleanup path. Raw error messages, URLs, arguments and credentials are never
written by this diagnostic; ordinary guest output retains its existing bounds.

`dim execution capacity /absolute/private/provider.json` optionally starts
pre-enrolled worker loops on demand using a dedicated scoped capacity connection.
It preserves the normal backends, host cache routing and installed task handlers;
provider code contains no scheduler-specific VM implementation. Idle reclaim
requires scheduler drain/revision authority, the same actual owned loop instance,
and clean local journals. For persistent supervision, invoke the installed
`dim-host execution capacity /absolute/private/provider.json` directly using
the operator configuration's `host.executable` path. Its first SIGTERM drains
instead of aborting occupied work; allow the supervisor to wait for that drain.
The transport CLI has a separate five-second cancellation bound and must not
supervise this graceful shutdown.
The provider host does not need an operator credential. Nothing is started by
installation alone. See the [fixed-pool setup and budgets](../../../../docs/guides/ci-runners.md#demand-managed-worker-pools).
