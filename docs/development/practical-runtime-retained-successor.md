# Retained adapter and canonical fixture successor

This focused successor starts from frozen reviewed
`d5994914aff33d14526dd7c6e4fbb7d7357a4081`. That candidate and its artifacts are
unchanged. Earlier exact-CAS recovery, artifact/version, public SSH, strict URL,
session/monitor and scoped provider/accounting fixes remain in the parent.

## Confirmed retained startup failure

Pinned OpenCode 1.18.31 startup with only the modern `.mjs` adapter was clean.
With the exact previous reviewed `.js` artifact retained alongside it, `/config`
still returned 200 but logs reported duplicate `dim-responses` provider hooks and
modern nonce configuration was missing. HTTP success alone is not startup proof.
The retained pair did not reproduce the earlier non-function-export wording.
No model execution was requested by this startup reproduction.

The narrow retirement guard recognizes only SHA-256
`6b688c7bcc9e57cdda3ea6ce8c2e17c49810ad7065436cd3489f33d6129d39d5`
from reviewed prior `1d442003452f93917e5ed24d4450cbc4323e5cc0` artifacts.
There was no per-file adapter ownership receipt to reuse or invent. Directory
descriptors, private owner/mode/link checks, bounded hash reads and synchronous
byte/inode rechecks plus atomic capture into a private staging directory limit
retirement to that exact prior file. A late replacement is retained and restored
without overwriting any concurrently recreated pathname. Unknown, edited
or unsafe files survive with explicit inspection/remediation guidance. This is
practical guest-filesystem protection, not a hostile same-UID isolation claim.

## Canonical fixture corrections

The coordinator reports the normal frozen-d599 canonical run failed before
practical lanes: the independent Native image assertion still expected its old
12-package closure. The declared builder now selects 34 public packages: the
original 12, five managed-Git plugins and 17 GS packages, plus one private
deployment package. The scheduler assertion was not reached in that failed run;
its declared current closure is independently six packages, not the obsolete
scheduler package name. Both explicit assertions now track those reviewed
selected inputs and reject extras; no runtime behavior checks are removed.

The registered integration workflow gains only a distinct manual practical
lane. Required automatic check names, triggers and meaning remain unchanged.
Disposable host preparation explicitly installs cloud-init ISO tooling and
validates the newly created Incus bridge before inserting exact owned subnet
egress/established-return rules. Cleanup is source/machine/unique-comment bound.
No global firewall policy is changed. The now-evidenced systemd 255 keeper-ordering
fix uses `DelegateSubgroup=supervisor`, checks root-empty/only-MainPID-in-supervisor
before enabling controllers, and preserves the canonical service-root budget and
resource controls. See
[the CI contract](practical-runtime-ci.md) for prerequisites and receipt rules.

## Evidence boundary

Focused owner/command-plan/workflow checks and full strict compilation are source
evidence. Pinned config-only startup is not inference or VM acceptance. The old
failed canonical run remains failed and never qualifies this new source.
Fresh normal canonical VM replay, runner readiness, publication/admission and
CI dispatch remain coordinator-owned. Missing KVM, sufficient memory, required
lane, exact receipt or owned cleanup cannot count as successful runtime coverage.
