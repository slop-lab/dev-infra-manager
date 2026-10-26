# Explicit selected-host usability smoke

This operator-run scenario exercises a reviewed DIM source installation through
the normal client/selected-host boundary. It never selects the current host: one
or more `--host NAME` arguments are mandatory, and every selected name must have
an exact profile in a private reviewed configuration file.

The full run creates one uniquely suffixed `dim-smoke-*` workspace per host from
an explicitly provisioned disposable managed Project at `installedSourceSha`.
It verifies the selected host version and required plugins, the exact candidate
checkout SHA, actual guest Git fetch and ordinary-branch push/readback, guest plugin
discovery, an actual OpenCode inference that uses a file tool, the owned OpenCode
server, an existing shared ingress reaching its HTTP authentication boundary,
and persistence/reconnection after `recreate`. It discards only the learned
workspace UUID with `--expect-id`; the workspace discard owns route cleanup.

After the ordinary-branch push, the runner uses the discoverable `dim-ci` helper
to request the exact candidate, repeats that same request to verify immutable
identity, and waits for all planned jobs plus a nonempty required-job gate to
succeed. The Project must have Git-CI policy and real registered worker capacity.
Missing policy, failed/stale/unavailable jobs or bounded pending timeout fail;
the runner never publishes fabricated worker evidence or cancels other work.

Its randomly named branch is deleted only after the remote still reports the
exact commit it pushed. A changed branch is retained for operator inspection.
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
      "expectedHostVersion": "0.10.0-local-REVIEWED_AGGREGATE",
      "requiredPlugins": [
        "agent-tools",
        "host-llm-router",
        "external-urls",
        "native-git"
      ],
      "ingress": "shared",
      "llm": {
        "configFile": "/absolute/host/private/llm/gateway.json",
        "project": "disposable-smoke",
        "route": "default"
      },
      "monitor": {
        "parentSessionId": "ses_REVIEWED_PARENT",
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
Full execution creates with
`--ref installedSourceSha` and checks the guest checkout against that SHA.
`expectedHostVersion` is compared with the selected host's `--version`, not the
client version. The source SHA is operator-declared provenance, independently
checked against the acquired candidate; a matching checkout alone does not
attest the installed host build. Retain the installation manifest mapping that
SHA to the exact host version with the run evidence. Plugin names are the names returned by `dim plugins`; the four
capability plugins above are mandatory rather than optional.

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

The monitor fixture is deliberately offline. It proves classification,
recursive discovery, OMO/API disagreement preservation and evidence redaction;
it is not evidence that any live parent-idle/child-busy case was observed.
