# Required practical runtime CI

The existing `examples-vm` job is the practical runtime gate. Its existing
main merge-group, main push, `v*` tag and manual triggers remain unchanged;
development pushes keep the ordinary source gate. The existing
`vm-runtime-acceptance` integration job remains a distinct required low-level
hardware check. Required names/coverage are in
`.github/required-runtime-checks.json`; repository enforcement is configured
externally and cannot be inferred from workflow source.

Before the Examples workflow is registered on default main, the already registered
Native integration workflow can be dispatched at a reviewed candidate with
`lane=practical`. Its distinct `practical-runtime-manual` check runs the unchanged
canonical `bash scripts/checks/examples-vm-smoke.bash` and then the same mandatory
exact-SHA/tree `verifyEvidence.ts` receipt validator. Source evidence and logs are
uploaded even on failure. It requires the same real KVM and 16 GiB prerequisites;
an approximately 10 GiB runner is not ready. This manual lane neither renames nor
substitutes for required `examples-vm` or low-level `vm-runtime-acceptance` checks.
On ordinary main/merge-group/tag events the unselected manual job has only its
distinct non-required name, never a duplicate skipped `examples-vm` context.
No new development-push hardware trigger or repository-rule change is implied.

## Provisioned path

### Reusing dependency baselines

The canonical `examples-vm` main/release/manual commands remain cold: they call
`examples-vm-smoke.bash` without a baseline. The opt-in
`.dim/ci/practical.example.yml` uses `practical-cold.bash` for the same reason.
Recurring scheduler runtime checks may instead select
`.dim/ci/practical-runtime.example.yml`. Its normal `practical.bash` uses the
fixed read-only `/mnt/dim-tools/baselines/manifest.json` only when the trusted
supervisor provides it; otherwise it runs cold. It never chooses an image or
host cache path from workflow input. The exported `qualification.json` records
the actual mode, exact source/tree and baseline recipe identity.

Build an operator-owned dependency artifact from reviewed source, outside a
candidate job. The builder requires KVM, QEMU, cloud-localds, SSH, Node 24/26 and
the exact pinned Ubuntu cloud image. It boots only one guest at a time (3 GiB
CP, then 8 GiB host); reserve another 1 GiB for the builder and host headroom.

```bash
node scripts/checks/vm-baseline.ts build /absolute/new-baseline /absolute/pinned-ubuntu.qcow2
node scripts/checks/vm-baseline.ts clone-check /absolute/new-baseline/manifest.json /absolute/new-clone-evidence
node scripts/checks/vm-baseline.ts image /absolute/new-baseline/manifest.json \
  registry.example/hardware-supervisor@sha256:REVIEWED_DIGEST registry.example/hardware-baseline:reviewed
```

The CP baseline contains OS and pinned Node/pnpm/Just; the host additionally
contains pinned Docker/Sysbox and Incus dependency packages. No source checkout,
DIM installation/configuration, SHA-bound bootstrap marker, workload, Incus
project/network, or login/host credential is retained. Cloud-init, machine and
SSH identities are scrubbed before flattening. Each file is standalone qcow2
with no external backing/data-file reference, and the manifest binds its full
SHA-256 and the complete installer/toolchain recipe. Consumers hash private
copies before QEMU uses them. Changed recipes fail clearly and require rebuilding
or explicit cold installation; there is no writable cache shared by jobs.

Publish the built OCI layer normally and enroll its exact registry digest in
trusted hardware profiles. It adds only read-only artifacts to the existing
tools mount. A mixed cold/baseline QEMU pool remains valid for the normal runtime
entrypoint. `practical-cached.bash` is a fail-closed cache qualification command;
use its example only with an exclusively baseline-capable pool. Scheduler
placement does not grant candidate-selected images or infer cache capability.

Every run creates distinct writable CP and host disks, imports the exact source,
and installs/builds current DIM afresh. Guest-observed machine IDs, cloud-init
instance IDs and SSH host fingerprints prove independent identities. The clone
check proves dependency/empty-state boot only; a successful cached practical job
is still required for full runtime qualification. The nested Incus CI image is
still prepared cold in this first implementation. Cached success never replaces
the explicit main/release cold-bootstrap proof. Stage logs retain UTC timestamps
and elapsed seconds from an available monotonic clock in `stages.jsonl`, including
quiet success. A run selects one clock source; unavailable readings become JSON
`null` and never replace the command's exit status or discard its private log.

The existing QEMU provisioner owns two separate Ubuntu CP/host VMs and pinned
inter-VM SSH. It prepares exact source/tree and package manifests, a private
test issuer/read actor and shared ingress, plus an Incus VM image derived from
the reviewed Ubuntu image and pinned Node seed. Only the disposable user's
manager is refreshed after adding normal Docker/Incus/KVM groups; production
permission policy is not relaxed. The outer runner needs real KVM, at least
16 GiB memory and the existing source tooling/network/image prerequisites.

Disposable host preparation explicitly installs `genisoimage` and verifies its
`mkisofs` entrypoint for Incus cloud-init disks. After creating `practical-ci`,
it queries the actual managed bridge, validates the requested IPv4 address/NAT,
disabled IPv6, kernel bridge/address and enabled IPv4 forwarding, and derives
`10.211.42.0/24` from that validated configuration. Two uniquely commented
FORWARD rules permit only source bridge/subnet egress and RELATED/ESTABLISHED
return to that bridge/subnet ahead of Docker forwarding policy. No policy,
unrelated rule, NAT configuration or root-host firewall is changed. A private
receipt binds inserted rules to the exact source and disposable host machine.
Partial setup rolls back only inserted rules; the practical lane removes its
exact rules before writing success and requires the cleanup receipt. Early
process loss or failures outside that lane still require canonical deletion of
the entire owned disposable VM. On the fixed Ubuntu/systemd 255 fixture,
`DelegateSubgroup=supervisor` puts the sleep keeper in that subgroup. Preparation
checks the canonical service-root `cgroup.procs` is empty and the supervisor holds
only the reported MainPID before enabling cpu/memory/pids at the service root.
The budget root, hierarchy ownership and resource controls are unchanged.

The Native/scheduler image check retains independent explicit package lists,
including only the selected 35 public Native packages and six scheduler packages.
Only Native admits private `@this-project/control-plane-deployment`. Declared
builder inputs are regression-checked against these lists, including rejection
of unexpected host/CLI/web/worker/LLM/test packages. Entrypoint, readiness,
activation, query, compatibility and read-only state checks remain required.

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
