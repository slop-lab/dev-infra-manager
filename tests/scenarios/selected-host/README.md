# Explicit selected-host usability smoke

This operator-run scenario exercises a reviewed DIM source installation through
the normal client/selected-host boundary. It never selects the current host: one
or more `--host NAME` arguments are mandatory, and every selected name must have
an exact profile in a private reviewed configuration file.

The full run creates one uniquely suffixed `dim-smoke-*` workspace per host from
an explicitly provisioned disposable managed Project at the profile's distinct
`workspaceSourceSha`; `installedSourceSha` remains installation provenance only.
It verifies the selected host version and required plugins, the exact candidate
checkout SHA, actual guest Git fetch and ordinary-branch push/readback, guest plugin
discovery, guest SSH setup and persistent host identity, a direct authenticated
HTTP request through the guest shared stdio service channel, an actual OpenCode
inference that uses a file tool, the owned OpenCode
server, an existing shared ingress reaching its HTTP authentication boundary,
and persistence/reconnection after `recreate`. It discards only the learned
workspace UUID with `--expect-id`; the workspace discard owns route cleanup.

After the ordinary-branch push, the runner uses the discoverable `dim-ci` helper
to request the exact candidate, repeats that same request to verify immutable
identity, and waits for all planned jobs plus a nonempty required-job gate to
succeed. The Project must have Git-CI policy and real registered worker capacity.
Missing policy, failed/stale/unavailable jobs or bounded pending timeout fail;
the runner never publishes fabricated worker evidence or cancels other work.

Its randomly named branch is deleted only with an explicit Git lease for the
exact commit it pushed, after matching remote readback. If the branch changed,
cannot be inspected, or deletion fails, both the branch and workspace are
retained for operator inspection; workspace discard is not attempted.
Partial creation learns the exact random name's UUID and checks source and
creation time before cleanup; it never discards a merely similar workspace.

It does **not** install host plugins, deploy a router/ingress, authenticate
an account, approve a route or change a firewall. It explicitly attaches only
the new owned workspace through the selected existing gateway, then installs
its pinned OpenCode guest tools. Server credentials are read only through the
public tools capability, held in memory and never printed. Missing
Docker/Sysbox access, plugins, issuer scope, provider authentication, configured ingress, route approval, DNS or
network reachability fail the relevant step. They are never converted into a
mock pass or skipped optional outcome.

## Configuration

Keep the file outside the repository when it contains private host paths. Every
key is required and unknown keys are rejected:

```json
{
  "schemaVersion": 1,
  "installedSourceSha": "0123456789abcdef0123456789abcdef01234567",
  "hosts": [
    {
      "name": "disposable-devbox",
      "workspace": "dim-smoke-daily-disposable-devbox",
      "source": "dim://dim-smoke-project",
      "workspaceSourceSha": "89abcdef0123456789abcdef0123456789abcdef",
      "expectedHostVersion": "0.10.0-local-REVIEWED_AGGREGATE",
      "requiredPlugins": [
        "agent-tools",
        "host-llm-router",
        "external-urls",
        "native-git"
      ],
      "ingress": "shared",
      "sshPublicKey": "ssh-ed25519 REVIEWED_PUBLIC_KEY dim-smoke@example.invalid",
      "llm": {
        "configFile": "/absolute/host/private/llm/gateway.json",
        "project": "disposable-smoke",
        "route": "default"
      },
      "monitor": {
        "parentSessionId": "ses_REVIEWEDPARENT",
        "directory": "/workspace/main",
        "maxSessions": 80,
        "maxDepth": 8,
        "maxRequests": 240,
        "recentMessages": 12,
        "staleMinutes": 15,
        "deadlineSeconds": 90,
        "requestTimeoutSeconds": 10,
        "omoMetadataPath": "/home/dim/.local/state/reviewed-omo-team-metadata.json"
      }
    }
  ]
}
```

`source` is interpreted on the selected host. An operator must provision and
attach a dedicated `dim-smoke-*` Project/repository containing the reviewed
candidate, with ordinary branch write/delete permission and no application
work in progress. The runner does not create or delete this operator-owned
Project: the current public Project API has no deletion capability. Its lifecycle
cleanup remains an explicit operator/VM-fixture gate, not a claimed runner result.
Full execution creates with the profile's `--ref workspaceSourceSha` and checks
the guest checkout against that SHA. This commit is the freshly provisioned
smoke seed and may intentionally differ from `installedSourceSha`.
`expectedHostVersion` is compared with the selected host's `--version`, not the
client version. The source SHA is operator-declared provenance, independently
checked against the acquired candidate; a matching checkout alone does not
attest the installed host build. Retain the installation manifest mapping that
SHA to the exact host version with the run evidence. Plugin names are the names returned by `dim plugins`; the four
capability plugins above are mandatory rather than optional. A profile may also
select `kvm`; when it does, the ordinary smoke workspace requires KVM discovery
to remain blocked with `runtime-grant-required`. Without selected KVM, the smoke
does not invent a KVM requirement. It never invokes the KVM verification
operation or claims host delegation. Actual VM-fd effect belongs only to a
separately authorized `container-kvm` workspace.

`sshPublicKey` is one reviewed OpenSSH public key, not a private key or host
credential. The smoke configures the guest's loopback SSH service, retains its
public host key only in memory and requires that identity after recreation. A
separate installed-host acceptance may drive a real SSH client through
`dim connect`; this runner never reads or persists a private client key.

`monitor` is optional. Its task identity and bounds are externally supplied;
the runner does not discover task files, assume a host path or select a parent.
It obtains the already-owned OpenCode server credential through the public
Workspace tools console, keeps it only in memory and sends it only as an HTTP
authorization header. Credentials never belong in configuration, evidence,
logs, prompts, process arguments or URLs.

The monitor reads `/session/status`, a bounded session list, the named parent,
bounded recent message metadata, both list `parentID` relationships and every
visited `/session/ID/children` endpoint. Recursive OMO leads and members count
against the same depth, session, request and total-time limits. Evidence retains
only validated session IDs, timestamps, roles, safe tool names/statuses and
error names/status codes; prompt/thinking text and tool arguments/output are
never retained. Parent idle plus child busy aggregates to active. Quiet busy
work remains `active-stale`; current and historical failures remain separate.
Truncated or partial idle discovery is `unknown`, and API failure is
`unreachable`. Completion is always `not-assessed` because status monitoring is
not task acceptance.
When configured monitoring is unreachable, unknown or only partially discovered,
the smoke report is `incomplete` and exits with code 2, even if its other runtime
checks passed. Preflight also requires nonempty doctor checks with every `ok`
strictly true; an exit-zero doctor command alone is insufficient.

`omoMetadataPath`, when present, names an independently installed, guest-owned
adapter output file. The narrow JSON shape is `source`, `enabled`, `truncated`,
`unreadable`, and `teams[]` with `leadSessionId`, `status`, `modifiedAt` and
bounded `members[]` session/status pairs. The runner neither installs that
adapter nor reads OMO directories directly. Runtime member status is
cross-checked with OpenCode API state; disagreements are preserved. Omitting
the path removes the optional OMO source without making it a core dependency.

The optional read-only adapter can run explicitly from a reviewed DIM checkout:

```sh
node scripts/checks/omo-team-metadata.ts --base-dir "$HOME/.omo" \
  --max-runs 16 --max-members 80 --deadline-ms 5000
```

It reads only owned regular `runtime/RUN/state.json` files, rejects symlinks,
bounds runs, total members, file bytes and elapsed scanning, and emits sanitized
membership metadata. It does not resolve credentials, inspect model/role config,
run DIM setup, or print prompt/thinking/tool payloads. Supply its JSON through the
explicit adapter-output path; do not deploy it by materializing an active user
workspace. No environment-specific target paths or Docker credential reads are
part of this implementation.

Use a new `dim-smoke-*` workspace prefix. Preflight refuses a prefix already present
on its host, and execution adds a random per-run suffix. It learns the created UUID from DIM before any
destructive cleanup; a mismatched name or malformed UUID stops cleanup and
retains evidence for operator inspection.

## Invocation

### Inspect an existing task without workspace mutation

The standalone monitor accepts existing server endpoints and parent identities;
it does not create a smoke workspace or invoke any DIM, SSH, Docker, setup or
restart command. Put only metadata in an owned regular JSON file:

```json
{
  "schemaVersion": 1,
  "targets": [
    {
      "name": "existing-task",
      "serverOrigin": "https://reviewed-opencode.example.invalid",
      "monitor": {
        "parentSessionId": "ses_REVIEWEDPARENT",
        "directory": "/workspace/main",
        "maxSessions": 80,
        "maxDepth": 8,
        "maxRequests": 240,
        "recentMessages": 12,
        "staleMinutes": 15,
        "deadlineSeconds": 90,
        "requestTimeoutSeconds": 10
      }
    }
  ]
}
```

Replace the example origin and identity with the explicitly reviewed existing
task. Origins must be HTTP(S), with no credentials, path, query or fragment.
An optional absolute `omoMetadataFile` on the target selects an existing local
adapter-output file, not a guest execution path. Files are opened without
following a final symlink and reads stay within 2 MiB even during concurrent
growth. Evidence includes only OMO teams and members visited in the selected
parent's bounded task tree, not unrelated runs in a shared adapter output.

Pipe an authorized in-memory credential producer into:

```sh
node scripts/checks/opencode-task-monitor.ts \
  --targets /absolute/private/opencode-targets.json \
  --target existing-task --credentials-stdin --json
```

The producer must send the JSON envelope
`{ "schemaVersion": 1, "credentials": { "existing-task": { "username": ..., "password": ... } } }`
on stdin and close it. Do not persist that envelope, interpolate secrets in a
shell command or include them in process arguments. Input is limited to 64 KiB
and 10 seconds. Credential resolution is operator-owned; this driver contains no
environment-specific paths, Docker credential reads or target discovery.

Repeat `--target` to inspect multiple selected entries sequentially. Without
`--json`, progress is incremental. Exit 0 means inspection was complete, not
that the task succeeded or finished. Partial/truncated discovery exits 2 with
`incomplete`; API unavailability exits 2 with `unavailable`. Activity and current
or historical errors remain separate evidence. Completion is always
`not-assessed`. Help is immediate and offline; unknown flags fail before input
files or endpoints are accessed.

### Exercise a disposable selected host

Run the mutation-free checks first:

```sh
pnpm --dir tests exec tsx ../scripts/checks/selected-host-usability-smoke.ts \
  --config /absolute/private/selected-host-smoke.json \
  --host disposable-devbox --preflight-only
```

Then run the live scenario only on explicitly approved disposable hosts:

```sh
pnpm --dir tests exec tsx ../scripts/checks/selected-host-usability-smoke.ts \
  --config /absolute/private/selected-host-smoke.json \
  --host disposable-devbox
```

Repeat `--host` to run the same checks sequentially on multiple reviewed hosts.
The runner emits credential-free `ok`, `unavailable`, and `pass` records. It does
not publish tool output, server credentials, route grants, or backend stderr.
When a live command fails, rerun that exact surface interactively on the named
host to inspect its private diagnostics.

Add `--json` for one structured credential-free report instead of incremental
text progress. `--help` is immediate and offline, and unknown arguments fail
before configuration, host or network access.

No selected hosts are part of the repository test suite. Parser and ownership
regressions run without DIM, Docker, network access or operator credentials:

```sh
pnpm --dir tests exec vitest run \
  scenarios/selected-host/config.test.ts \
  scenarios/selected-host/monitor.test.ts \
  --no-file-parallelism
```

The monitor fixtures use in-memory responses or disposable loopback HTTP servers,
including the public standalone CLI. They prove classification, recursive
discovery, OMO/API disagreement preservation, file-growth bounds and evidence
redaction. They do not establish that any operator's live task was observed.

An explicit source-runtime gate proves actual core discovery and LLM HTTP bytes
through two fresh stdio helpers inside disposable Docker containers with
`--network none`. Host targets bind loopback only; the guest also proves that
host loopback is directly unreachable. No firewall rule is read or changed:

```sh
IMAGE_EVIDENCE="$(pnpm --dir tests exec tsx scenarios/selected-host/buildRuntimeImage.ts)"
IMAGE_ID="$(node -e 'const v=JSON.parse(process.argv[1]);process.stdout.write(v.image)' "$IMAGE_EVIDENCE")"
IMAGE_OWNER="$(node -e 'const v=JSON.parse(process.argv[1]);process.stdout.write(v.owner)' "$IMAGE_EVIDENCE")"
DIM_SELECTED_HOST_STDIO_IMAGE="$IMAGE_ID" \
  pnpm --dir tests exec vitest run \
  scenarios/selected-host/runtimeStdio.test.ts --no-file-parallelism
```

`buildRuntimeImage.ts` constructs an offline `FROM scratch` image from the
current Node executable, `/sbin/ip` and their exact dynamic libraries. Its JSON
records the immutable image ID, unique `dev.dim.test.fixture` owner label and
Node SHA-256. It does not pull a base image. Retain that JSON with test output.
The fixture removes each exact named container before opening the next bridge.
It verifies transport/reopen mechanics, not installed selected-host
configuration, external ingress, provider inference or VM/KVM effect. Remove
only the proven owned image after checking its label:

```sh
test "$(docker image inspect --format '{{ index .Config.Labels "dev.dim.test.fixture" }}' "$IMAGE_ID")" = "$IMAGE_OWNER"
docker image rm "$IMAGE_ID"
```

The same gate also creates a Linux bridge device with `172.20.0.1/16` and an HTTP
shadow at `172.20.0.1:18318` inside a second pair of fresh `--network none`
containers. It asserts `ip route get 172.20.0.1` resolves as
`local 172.20.0.1 dev lo`, proves both direct shadow endpoints return the explicit
`nested-bridge-shadow` marker, then requires generic discovery and LLM model HTTP
to reach the distinct host-owned named services through stdio. This models the
kernel route collision caused by a nested bridge; it does not start inner dockerd.
This collision case needs Docker to grant `NET_ADMIN` inside the disposable test
container and the reviewed image to contain `ip` from iproute2. Failure to meet
either prerequisite is a failed runtime gate, not evidence about the channel.
