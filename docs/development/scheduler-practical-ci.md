# Practical runtime verification through DIM CI

The default `.dim/ci/runner.yml` remains source-only. The compiler currently runs
all declared jobs and has no branch filter. Heavy VM work therefore does not run
on every development request. Automatic main/release-only required-stage policy
is a separate follow-up, not delivered by this opt-in path.

For an explicit reviewed qualification candidate, copy
`.dim/ci/practical.example.yml` to `.dim/ci/runner.yml`, commit that change on the
unprotected qualification branch, and request that exact immutable candidate
through the normal workspace `dim-ci request --request-id UUID --ref REF` path.
The normal scheduler then owns both source and practical execution. A source-only
green result is not practical qualification; inspect the actual practical job,
exact candidate/tree, result, artifacts and cleanup before accepting the gate.
No workflow filename, candidate environment variable or repository configuration
grants hardware or operator credentials.

An operator first builds and pins the separate Ubuntu hardware runner described
in the execution-worker README and enrolls a dedicated `vm` slot using normal
execution enrollment. Runner and job image must be the same digest. Use at least
4 CPU, 20 GiB, a 10800-second wall budget and disk-backed worker state with 80 GiB
free. The full guest probes actual nested KVM and supplies a separate 64 GiB
scratch disk for `/tmp`. This is distinct from GitHub runner registration and from
small QEMU or ordinary Sysbox capacity. Missing hardware capacity remains queued
or fails readiness; it never qualifies the job by skipping runtime work.

The trusted hardware reader uses the existing repository-scoped execution lease
to fetch depth two. It exports only the verified candidate raw commit and up to
eight distinct immediate-parent raw commits/trees, within the shared 256 MiB
materialization budget. No refs, Git configuration, remote URL, askpass helper,
credential or older ancestor enters the guest. Ordinary acquisition remains
candidate-only and contains no `.git`. The service upload-pack lease is repository
scoped; object narrowing here is trusted-reader behavior, not a new claim of
server-enforced commit-only authorization.

The opt-in wrapper verifies all exported object hashes and reconstructs exact
local Git objects, with each immediate parent marked shallow. Merge candidates
retain all immediate parents, while canonical update verification uses the first
parent baseline. A root commit cannot qualify an upgrade because it has no
baseline. Git bundles do not preserve a repository’s shallow boundary. Canonical source
manifests therefore carry optional `boundedParents` naming exactly every immediate
parent. Both the operator validator and pristine guest importer verify that list
against the raw candidate and reject extra commit ancestry before applying the
boundary, fetching and running strict object verification. Full-history manifests
omit the field. This preserves exact commit/tree identity without inventing a
snapshot commit or exposing history. The wrapper installs the pinned
source tools, builds the exact source, then invokes the unmodified canonical
`scripts/checks/examples-vm-smoke.bash` and mandatory exact-source receipt verifier.

Fixture evidence initially lives in private disk scratch. The finalizer exports
only source/role/runtime receipts and three named stage logs plus the control-plane
service diagnostic, including on failure. It excludes operator configuration,
cloud-init, SSH keys, raw fixture directories and unrecognized files. Known
credential fields/authorization/private-key blocks are redacted. Stage logs are
bounded and their export manifest records original sizes/digests/truncation.
The fixed artifact root is `/workspace/.dim-ci-artifacts`; the generic execution
artifact service owns byte capture, storage, retention and scoped retrieval.
Generated test credentials are not a useful artifact. Provider qualification is
still not assessed: canonical CI uses its deterministic test-only backend through
the actual scoped router/tool path.
