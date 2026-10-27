# Disposable non-Git workbench

This harness starts the real DIM Web HTTP/session/plugin stack around a synthetic
controller. It never reads DIM operator configuration, provider accounts, Docker,
SSH, or production service state.

```sh
DIM_CHROMIUM=/usr/bin/chromium \
  node --disable-warning=DEP0205 --import tsx --conditions=dim-source \
  web/non-git-workbench/serve.ts --metadata /tmp/dim-non-git-workbench.json
```

Run from `tests/`. The printed mode-0600 metadata contains the console URL,
synthetic credentials, a Chromium CDP URL when the local binary can start, PID,
and explicit cleanup command. If Chromium's shared libraries are unavailable,
the server remains live and metadata reports `browserLaunchError` for an external
browser evaluator.
Stopping the process closes Chromium and the Web listener and removes its unique
temporary directory.

After `pnpm install --frozen-lockfile` and `pnpm workspace:build`, run the complete
disposable non-Git browser lane from the repository root:

```sh
DIM_CHROMIUM=/usr/bin/chromium pnpm --dir tests run test:web-non-git
```

This includes the real LLM owner/ledger fixtures, unknown-write and stale-read
reconciliation, account access, workspace phase/draft preservation, native
history, and exact execution-controller location tests. The serve fixture's LLM
and execution mutation responses are synthetic view data, not a durable service
implementation; use the owning journeys to verify actual state effects.

Synthetic: three hosts (including one unavailable), workspace/runtime states,
workspace tools and credentials, routes, LLM accounts/models/projects/traffic,
and execution jobs/capacity. Real: Web authentication/session cookies, origin and
CSRF enforcement, account roles, plugin loading/assets, operation validation,
controller subprocess transport, and browser rendering.
