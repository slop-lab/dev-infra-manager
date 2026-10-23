# Browser journeys

These checks protect user outcomes, not the current screen design. Navigation,
labels, forms and even entire steps can change during UI work. Rewrite or remove
their adapters and obsolete checks with that work; existing tests are not a
compatibility contract.

Run from the repository root after installing dependencies and building packages:

```bash
DIM_CHROMIUM=/absolute/path/to/chromium pnpm --dir tests run test:web-journeys
```

Select a reviewed Chromium executable explicitly. The CI workflow installs the
browser revision pinned by the existing `playwright-core` dependency and checks
its version; `DIM_CHROMIUM_VERSION` enables that check locally too. A missing
browser fails the command instead of silently skipping the journey.

## Responsibilities

- `review.ts` describes the user journey and its observable outcomes. It has no
  selectors, CSS or response mocks.
- `native-git/ui.ts` owns today's screen interactions. Change it when the UI
  changes; do not add production aliases or hidden controls to preserve it.
- `native-git/environment.ts` owns disposable services, operator connections,
  fixture data and independent state verification. It does not pregrant the
  browser's reviewer role.
- `support/` owns browser lifecycle, cleanup, step timings and failure evidence.
  Keep feature-specific actions with their feature instead of adding a generic
  flow DSL or a comprehensive page-object hierarchy.

Prefer accessible roles and labels in the small UI adapter. Check business
results independently of the screen: successful promotion must change the
actual protected Git ref. Do not assert broad DOM snapshots, layout, incidental
copy, or every intermediate request in these acceptance journeys. Detailed
permission, policy, race and failure-injection tests stay with their owners;
existing standalone browser tests may be retained, rewritten or deleted for
their specific value, not to preserve the old UI.

## First journey: review access through promotion

The default initialized operator creates a project and imports a repository
through the UI. Fixture preparation then pushes an ordinary workspace proposal
changing `.dim/` and prepares its pending review as another reviewer. This is
test data, not a browser role grant or an approval. The operator opens that
review, encounters its missing reviewer permission, follows the account access
action, grants its own reviewer role with password confirmation, signs in again,
resolves the proposal through the UI, approves and promotes it. The final check
reads the real Git ref. Removing the access action or pregranting the role makes
this journey fail.

Web, host project management, Native Git and review/merge policy use production
implementations and disposable real state. A subprocess bridge invokes the
production host console. Only the public upstream HTTPS transport is redirected
to a local smart-HTTP Git server; no browser response or operation result is
mocked. This is a source component integration check, not an installer or VM
acceptance test. The environment never uses the operator's installed DIM state,
accounts, repositories or provider credentials.

`runReviewJourney` accepts an environment factory so an installed environment
can reuse the same user outcomes and UI adapter. An installed VM adapter is not
implemented yet. The existing examples VM gate verifies separate control-plane
and host VMs but does not currently run this browser journey. Keep that heavy
lane for main admission and releases rather than every development push.

## Diagnostics

Successful steps are quiet. Every run writes `timings.json` to a private new
directory under `.local/web-journeys/`; `DIM_WEB_JOURNEY_ARTIFACTS` selects another
parent. Failures print the failed step and evidence location, and add:

- `failure.png`, with inputs, editable areas and code/patch content masked;
- `trace.json`, containing step timings and bounded, allowlisted HTTP metadata;
- `diagnostics.json`, with fixed failure categories and numeric/boolean counters.

Raw Playwright traces, request/response bodies, passwords, cookies, arbitrary
URLs and browser console text are deliberately not collected. They can expose
login credentials. Register cleanup as soon as a resource is acquired; evidence
is captured before fixture teardown. The CI workflow uploads the sanitized
artifacts even on failure.

Timings are diagnostic samples, not a latency benchmark or a small fixed-time
performance contract. Use bounded waits for observable results, not sleeps or
blanket retries that hide failed user actions.
