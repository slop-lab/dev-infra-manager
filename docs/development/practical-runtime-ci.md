# Required practical runtime CI

The existing `examples-vm` job is the practical runtime gate. Its existing
main merge-group, main push, `v*` tag and manual triggers remain unchanged;
development pushes keep the ordinary source gate. The existing
`vm-runtime-acceptance` integration job remains a distinct required low-level
hardware check. Required names/coverage are in
`.github/required-runtime-checks.json`; repository enforcement is configured
externally and cannot be inferred from workflow source.

## Provisioned path

The existing QEMU provisioner owns two separate Ubuntu CP/host VMs and pinned
inter-VM SSH. It prepares exact source/tree and package manifests, a private
test issuer/read actor and shared ingress, plus an Incus VM image derived from
the reviewed Ubuntu image and pinned Node seed. Only the disposable user's
manager is refreshed after adding normal Docker/Incus/KVM groups; production
permission policy is not relaxed. The outer runner needs real KVM, at least
16 GiB memory and the existing source tooling/network/image prerequisites.

Fixture code is under `tests/scenarios/selected-host/ci/`. The CP runs installed
router/ingress packages and a clearly marked deterministic protocol provider.
No operator/provider account credentials are embedded or imported. A fresh
bounded 20-request project is used. Normal product issuer, scoped gateway,
admission, accounting and actual OpenCode file tools remain in the path.

The installed ordinary recipe derives two selections: local and real pinned
SSH to its normal installer-created public core-CLI entry. It does not select
the installer facade as an SSH workaround. Exact immutable workspace and Incus
image identities, seed SHA, provider/model, gateway/metadata paths and update
artifacts come from actual preparation, not a hand-authored private checklist.
The shared production `{urls:[...]}` decoder rejects ambiguous, foreign,
unapproved and unsafe endpoints before the existing HTTP/schema/challenge/auth
checks. Only exact run-owned resources are cleaned up.

## What must pass

Both selections must finish lifecycle/copy/resources/data, explicit routed
model/file tools, retained LLM binding after restart, app and authenticated
OpenCode ingress, fresh owned session/model metadata and post-run monitor,
real auxiliary VM grant/code/artifact/revoke and recreation/reconnection.
The separate isolated-installation lane must retain a running authenticated
service and nested data through a distinct exact-artifact update.

Router proof is not a global usage delta. A validated client nonce joins
admitted/settled request IDs to the exact workspace/project/principal/route and
requested/observed model, without raw credentials or transcripts. OpenCode's
fresh run events and authenticated assistant metadata must identify the same
session/provider/model. The monitor reads that session and descendants plus
pending question/permission metadata; it is post-run observation, not a claim
that every transient busy state was sampled or that an application task is done.

The outer gate requires `practical-runtime.json`, distinct real role identities,
matching source SHA/tree, both complete artifact-closure hashes and immutable
image bindings before reporting success. Missing hardware is pending/failure;
missing bindings, receipt, lane, uncertain cleanup or preflight-only execution
cannot produce a green required runtime check.

## Qualification boundary

Deterministic CI is protocol/tool/containment acceptance, **not external
provider/account qualification**. Optional authorized account checks are
separate. Old file-tool or real-provider receipts cannot qualify changed source,
and file output/catalogue HTTP alone cannot prove DIM-routed inference.
Actual workflow dispatch status, runtime results and repository required-check
enforcement must accompany acceptance. A source-only implementation or local
fixture test is not a successful expensive CI run.
