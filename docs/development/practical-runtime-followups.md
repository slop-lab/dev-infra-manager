# Installed runtime and required-CI follow-ups

This successor continues clean reviewed source
`1d442003452f93917e5ed24d4450cbc4323e5cc0`; exact-byte recovery ownership and
exact local artifact/recipe binding fixes remain intact.

## Confirmed source defects and fixed boundaries

- The actual installer-created public core CLI received SSH `__host` input as
  a user command and wrapped it again. Reserved requests now enter only the local
  host endpoint unchanged, with validation left to that owning parser and no
  client context lookup.
  A regression uses normal CLI installation, built CLI/host code, actual sshd,
  `/usr/bin/ssh -F` and pinned test-owned keys, preserving literal/empty argv,
  binary stdin and status 37. No installer-facade-only or fake-SSH proof is used.
- Both exposure consumers now share strict production `{urls:[...]}` decoding.
  Workspace, ingress, exact target, public fields, publishable approval and safe
  HTTP(S) URLs are checked before the original HTTP/auth/schema/challenge checks.
  Flat aliases, ambiguous/foreign/unapproved/malformed routes are rejected.
- The inference JSON stream supplies the fresh owned session. Authenticated
  session/model metadata and the bounded post-run monitor use that exact ID and
  actual working directory; configured foreign parents are rejected. CLI tool
  activity and result bytes are distinct from post-run state observation.
- Explicit DIM provider/model, a bounded nonce, and exact immutable scoped
  request/attempt accounting are required. File tools/catalogue HTTP alone do
  not qualify routing. Correlation uses existing audit storage without changing
  the ledger schema, authority, quota or idempotency semantics; nonce is not sent
  upstream and no prompt/transcript is included in the metadata receipt.
- Pinned OpenCode rejected the `.js` adapter as a non-function export. The same
  adapter bytes in an explicit `.mjs` module loaded correctly; deployment,
  package export, launch registration and server fingerprint now use that module
  while preserving unrelated plugin/model/profile/auth/session configuration.

## Reproducible checks

```sh
pnpm workspace:check
pnpm --filter @slop-lab/dim-cli... --filter @slop-lab/dim-host-plugin-llm-router... --filter @slop-lab/dim-control-plane-plugin-llm-router... run build
pnpm --dir tests exec tsx --conditions=dim-source --test cli/cli.test.ts cli/installedSsh.test.ts cli/hostTransport.test.ts
pnpm --dir tests exec vitest run scenarios/llm-router --no-file-parallelism
pnpm --dir tests exec vitest run scenarios/selected-host --exclude 'scenarios/selected-host/runtimeStdio.test.ts' --no-file-parallelism
```

Private initial-red/fixed logs use the `runtime-followup-*` prefix under the
task directory. Observed source checks: 15 CLI/transport tests, 150 owner tests,
88 selected-host checks, 26 installed-example/workflow checks, and full strict
checks for 76 projects. Curated final component/protocol checks passed 137 tests
across 32 files. These selections overlap and are not summed.

An isolated pinned OpenCode 1.18.31 deterministic turn executed actual read/write
tools through real issuer, gateway and router, with four nonce-correlated settled
requests and authenticated model/session metadata for the same fresh ID. Its
post-run monitor was complete/idle with no pending question/permission. That is
local deterministic protocol/tool evidence, not Sysbox/Incus/hardware or external
provider/account qualification. No paid provider calls were made by this source task.

## Required runtime qualification

The canonical separate-VM gate provisions and requires practical local/public-SSH,
routed deterministic OpenCode/accounting/owned-monitor, shared HTTP, real Incus
and isolated update coverage. Its validated exact-source receipt and the
low-level VM runtime receipt remain required before main/release through DIM or
local execution. GitHub hardware workflows are optional manual entrypoints for
configured runners, with no push/tag/merge-group queue or required context.
See [required runtime qualification](practical-runtime-ci.md).

Actual runtime execution and validated new-candidate receipts are
coordinator-owned and **not established by these source checks**.
Missing hardware/bindings/receipt/required lane is pending or failed, never a
successful skip. Historical real-provider/file-tool receipts do not qualify the
changed candidate, and the old canonical full-run failure is not relabeled pass.
Exact source/tree, complete matching 74-package artifacts and transport hashes
are recorded in the private handoff without a self-referential source receipt.
