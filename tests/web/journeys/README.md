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

With the same browser selection, `pnpm --dir tests run test:git-tools-web`
checks the portable React panel without a DIM adapter. It covers opaque service
IDs, draft/anchor reset and inputs during a pending comment. The Web workflow
runs it alongside the service journeys; its screen assertions are replaceable
when the component interaction changes.

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
to a local smart-HTTP Git server. The review-access journey does not replace
browser responses. The PR journey routes its disposable Native Git connection
through a loopback proxy that rejects exactly the post-promotion PR refresh once.
Promotion, metadata edits, comments, detail reads and the later explicit refresh
still reach the real service. This exercises the service client's documented
`refreshPending` contract without fabricating approval or CI evidence. This is a
source component integration check, not an installer or VM acceptance test. The
environment never uses the operator's installed DIM state, accounts, repositories
or credentials.

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

## Pull requests and changing revisions

`pull-requests.ts` exercises project creation and import, reviewer access, PR
creation, structured diff, general and inline discussion, independent line
attribution, approval, and merge. The workspace then resets to the original base,
creates a different candidate and force-pushes it with an exact lease. The old
inline comment remains outdated and the earlier approval cannot merge that
rewritten candidate. The journey verifies the actual protected `main` ref and
the accepted-merge `refreshPending` receipt/refresh sequence. While that refresh
is pending, it edits metadata, posts a real comment, reselects the PR after opening
a sibling PR, and injects an unavailable review-detail read. The receipt and merge
lock must survive every same-revision response; only an authoritative merged read
or a new revision clears the lock.

Its replaceable screen adapter is `native-git/pull-request-ui.ts`. The scenario
records user outcomes and uses the same disposable real-service environment as
the review journey; it does not keep today's component tree or CSS as a contract.
Both journeys run through `test:web-journeys` in normal CI. For a targeted local
run, append `pull-requests` or `review` to that command.

The PR journey uses an ordinary source branch, inspects structured diff and line
attribution, prepares review, approves/revokes, force-updates the source, checks
stale approval/outdated discussion and merges the exact new revision. Preparation
does not itself approve. DIM CI absence is displayed separately from human review.

With the same Chromium selection, `pnpm --dir tests run test:web-git-sync`
switches between two repositories in one Project, verifies review/promotion
receipts clear at the scope boundary, and publishes each protected head only to
its own disposable bare upstream. The primary repository also exercises managed
branch merge/review/promotion. The Web workflow runs this check alongside
PR/review and attachment journeys; no installed operator service or external
GitHub repository is mutated. Failed admission/execution and missing CI policy
are never converted into successful DIM CI evidence by these browser checks.

## Existing Projects on another host

With the same `DIM_CHROMIUM` selection, run
`pnpm --dir tests run test:web-native-management`. This standalone browser check
uses real Git authority and host-console subprocesses with independent host
state. It discovers a Project imported on the first host, inspects repositories,
selects different configuration/default repositories and attaches it to the
second host. It checks persisted selections independently of the screen, rejects
local collisions without replacing choices, verifies managed workspace draft
navigation and denies a read-only browser account's attachment request. The
ordinary project-creation/import regressions run in the same check. The browser
workflow runs it alongside the review and PR journeys; no live host installation
or operator state is used.
