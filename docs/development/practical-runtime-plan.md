# Ordinary multi-host runtime reliability

## Source and boundaries

Base: `f74e7a854c65a9d82014abe5f14b4265ec544cda`, tree
`5bcd2008b5ca3e36463ef0f3a524fe8126f0eaa0`. The requested normal GitHub fetch
failed authentication; the exact commit already present locally is the inspection
base pending coordinator confirmation/read access. No old candidate commits are
replayed. Production installations and other workspaces are not test fixtures.

## Stages

1. **Recovery ownership.** Preserve the host LLM plugin's pinned gateway identity,
   scoped guest token and current gateway binding. Missing legacy selection must
   not choose an arbitrary config: report an exact workspace/project repair
   command and retain the existing credential. Publish preparation failure as a
   running runtime with an explicit integration error, without stopping an
   existing workload. Successful preparation clears only its own prior error.
2. **Ordinary selected-host journey.** Extend the existing selected-host scenario
   with an ordinary-source mode, resources/copy/start/restart persistence checks,
   a disposable application endpoint distinct from OpenCode, and actual scoped
   LLM inference/OpenCode/ingress recovery. Native Git/CI remains an independently
   selected managed-source mode, not an ordinary-workspace prerequisite.
3. **Explicit heavy lanes.** Reuse the same scenario's operator-selected profiles
   for auxiliary VM provisioning/grant/discovery/exec/copy/revoke/exact cleanup
   and isolated installation update retaining a running workspace. No production
   reinstall, fleet restart, implicit host KVM grant or control-plane credential
   delivery is permitted. Separate host/control-plane VM acceptance remains real
   independent VMs.
4. **Discoverability and evidence.** Link the runnable command/example from normal
   guest guidance; retain owner-specific auth and application DTO boundaries.
   Record candidate SHA, selected host/version, commands/exits and sanitized
   per-lane PASS/FAIL/BLOCKED evidence. Missing capability is never a passing skip.

## Acceptance matrix

| Lane | Required observation | Initial state |
| --- | --- | --- |
| Missing/pinned LLM selection | actionable denial without credential rotation; exact pinned helper/endpoint repair | source investigation complete |
| Partial lifecycle preparation | observed runtime and persistent integration error agree; retry clears failure | regression needed |
| Ordinary local/SSH workspace | identity/resources/copy/data survive start/restart/recreate | runtime host profile required |
| LLM/OpenCode/application ingress | real authorized model output, auth/session continuity, distinct app URL | scoped gateway/account/ingress profile required |
| Auxiliary KVM VM | agent discovers grant; actual VM build/artifact/revoke/cleanup | Incus/image/operator grant required |
| Isolated update | running workspace/data/scoped auth survive matching installation update | disposable installation profile required |

Local tooling has Node 24.22.1, pnpm 10.13.1 and working Docker runc. Sysbox and
`/dev/kvm` are unavailable in this workspace's daemon/device boundary. Source and
real nonprivileged stdio-channel checks can execute locally; the coordinator must
supply reviewed disposable host inputs for other lanes. Existing fleet runtime
state and credentials will not be inspected or altered to synthesize those inputs.
