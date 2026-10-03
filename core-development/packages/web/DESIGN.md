# DIM Reviewer Web Design System

This document is the design contract for the authenticated reviewer UI. The
showcase beside it remains a development artifact for validating primitives; the
packaged product screen uses the same tokens and component contracts against the
reviewer API.

## 0. Research Log

- **Embedded references:** shortlisted Linear, Sentry, and GitHub from the
  productivity, data-dense, and developer-tool groups. Picked Minimalist Layer A
  plus Linear Layer B because DIM needs restrained operational hierarchy and
  luminance-separated dark surfaces. Linear is used only for luminance and layout
  grammar: no logo, copy, purple brand ramp, or Inter typography is carried over.
- **Repository context:** the target package is greenfield and the repository has
  zero existing web components, CSS files, frontend frameworks, token sets, or
  browser build conventions. Adjacent contracts establish a quiet operator tone,
  authenticated host-scoped review, immutable complete-tree evidence, and the
  statuses `pending`, `approved`, `revoked`, and `stale`. Review does not imply an
  issue tracker, CI result, merge, promotion, or deployment authority.
- **Lazyweb:** ran three searches (`code review pull request approval diff`,
  `developer tool sign in authentication console`, and `pull request diff files
  approval checks`) and viewed five downloaded screens: Google Jules review docs,
  Sentry authentication, Lovable authentication, Optic review-list discussion,
  and GitHub code review. Harvested persistent orientation, focused sign-in forms,
  concise metadata rows, constraint banners, status-with-explanation, and diffs
  that keep comments/evidence adjacent to the affected lines. Marketing sections,
  decorative auth artwork, brand assets, and unconditional merge actions were
  explicitly rejected.
- **UI/UX database:** the operational trust search reinforced a dark neutral base,
  a scarce action color, explicit credentials/status, visible labels, 44px targets,
  keyboard focus, nearby plain-language errors, and reduced motion. Its suggested
  Fira pairing and bright run-green CTA were rejected in favor of the requested
  self-hosted Geist family and quieter approval semantics.
- **Designpowers Lane A:** primary persona is a careful human reviewer comparing
  exact evidence before an approval decision. Stress personas are a keyboard-only
  reviewer at 200% zoom, a low-vision reviewer needing strong contrast, and an
  incident responder scanning long paths and unbroken identifiers under time
  pressure. Success means identity, scope, evidence, blocking state, and the next
  safe action remain unambiguous without memory or color alone.
- **Designpowers Lane B:** every control needs default, hover, active, focus,
  disabled, and applicable loading/error states; content determines reflow; patch
  text remains selectable and horizontally scrollable inside its own named region;
  errors state cause and recovery; status updates use polite live announcements.
- **Designpowers Lane C:** browser evidence must cover 375px, 768px, 1280px, 200%
  zoom, keyboard order, long content, loading/empty/error, forced/reduced-motion
  preferences, and console errors before a primitive is accepted.
- **Imagen drafts:** skipped because no Imagen tool is available in this harness.
  No generated visual reference or fidelity claim is fabricated.
- **Evidence status:** prior primitive screenshots are stale after the control-border
  contrast correction and must be recaptured with the final product evidence.

## 1. Atmosphere & Identity

DIM Reviewer is a quiet evidence room: sober, bounded, and explicit about what a
human is authorizing. Its signature is the **evidence rail**, a cool-gray inset
surface where exact repository metadata and escaped patch text stay visually
connected to approval state. The remembered moment is not decoration; it is the
calm clarity of seeing a stale or blocked decision before reaching the action.

The interface is trust-first rather than brand-first. It avoids marketing language,
imaginary metrics, celebratory effects, and implied authority. Labels use concrete
verbs: `Sign in`, `Approve review`, `Revoke approval`, `Retry`, and `Return to queue`.

## 2. Color

Dark mode is the initial contract. A future light theme must define an equivalent
semantic mapping before implementation; it must not mechanically invert these
values.

| Role | Token | Value | Usage |
|---|---|---:|---|
| Canvas | `--color-canvas` | `#0b0d0f` | Browser background and deepest shell |
| Shell | `--color-shell` | `#101317` | Persistent app chrome |
| Panel | `--color-panel` | `#15191e` | Cards and grouped controls |
| Elevated | `--color-elevated` | `#1c2128` | Inputs, selected rows, active surfaces |
| Recessed | `--color-recessed` | `#0e1115` | Patch and immutable evidence wells |
| Text primary | `--color-text` | `#f3f5f7` | Headings, values, patch context |
| Text secondary | `--color-text-secondary` | `#b5bdc7` | Body copy and descriptions |
| Text muted | `--color-text-muted` | `#89939f` | Timestamps and auxiliary metadata |
| Border | `--color-border` | `#626b78` | Controls and strong separation |
| Border subtle | `--color-border-subtle` | `#252a31` | Rows and quiet panel boundaries |
| Action | `--color-action` | `#dce8ff` | Primary action surface only |
| Action text | `--color-action-text` | `#0b1a33` | Text on primary action |
| Action hover | `--color-action-hover` | `#edf3ff` | Primary action hover |
| Focus | `--color-focus` | `#9fc1ff` | Keyboard focus outline and links |
| Scroll track | `--color-scroll-track` | `#343a43` | Persistent patch position track |
| Scroll thumb | `--color-scroll-thumb` | `#9fc1ff` | Persistent patch position thumb |
| Approved bg | `--color-approved-bg` | `#123923` | Approved state surface |
| Approved text | `--color-approved-text` | `#9de5b8` | Approved state label |
| Approved border | `--color-approved-border` | `#2d7548` | Approved state boundary |
| Pending bg | `--color-pending-bg` | `#3a2b0c` | Pending/warning surface |
| Pending text | `--color-pending-text` | `#ffd37a` | Pending/warning label |
| Pending border | `--color-pending-border` | `#80611b` | Pending/warning boundary |
| Error bg | `--color-error-bg` | `#3b171c` | Error/revoked/deletion surface |
| Error text | `--color-error-text` | `#ffb9c0` | Error/revoked/deletion label |
| Error border | `--color-error-border` | `#8c3542` | Error/revoked/deletion boundary |
| Info bg | `--color-info-bg` | `#142e45` | Informational and stale surface |
| Info text | `--color-info-text` | `#a8d5ff` | Informational and stale label |
| Info border | `--color-info-border` | `#356487` | Informational and stale boundary |
| Diff addition bg | `--color-diff-add-bg` | `#102d20` | Added patch lines |
| Diff addition text | `--color-diff-add-text` | `#c3ebd0` | Added patch text |
| Diff deletion bg | `--color-diff-del-bg` | `#35191e` | Removed patch lines |
| Diff deletion text | `--color-diff-del-text` | `#ffd0d4` | Removed patch text |
| Diff hunk bg | `--color-diff-hunk-bg` | `#17253c` | Hunk headers |
| Diff hunk text | `--color-diff-hunk-text` | `#c3d5ff` | Hunk header text |

Rules:

- Surface luminance, not drop shadow, establishes hierarchy.
- Blue is reserved for focus, links, and the single primary action. It is never a
  decorative glow.
- Status always combines words with shape or iconography; color is never the only
  carrier.
- Patch addition/deletion colors are limited to line backgrounds and labels.
- Body text targets at least 4.5:1 contrast; focus and control boundaries target at
  least 3:1 against adjacent surfaces.
- Resting inputs and secondary controls use `--color-border`; the subtle border is
  reserved for non-interactive panel and row separation.

## 3. Typography

Self-host `Geist Sans` and `Geist Mono` as WOFF2 with `font-display: swap`. Do not
load remote fonts at runtime. System fallbacks are allowed only while the local font
asset loads. Inter is prohibited.

- Primary: `"Geist Sans", ui-sans-serif, system-ui, sans-serif`
- Mono: `"Geist Mono", ui-monospace, "SFMono-Regular", Consolas, monospace`
- OpenType: tabular numerals for hashes, counts, dates, line numbers, and revisions.

| Level | Token | Size | Weight | Line height | Tracking | Usage |
|---|---|---:|---:|---:|---:|---|
| Page title | `--font-page` | `1.75rem` | 600 | 1.2 | `-0.025em` | One screen title |
| Section | `--font-section` | `1.125rem` | 600 | 1.35 | `-0.012em` | Primitive/review sections |
| Component | `--font-component` | `1rem` | 560 | 1.4 | `-0.006em` | Card and state titles |
| Body | `--font-body` | `0.9375rem` | 400 | 1.6 | normal | Reading copy |
| Control | `--font-control` | `0.875rem` | 560 | 1.25 | normal | Buttons and inputs |
| Metadata | `--font-meta` | `0.8125rem` | 450 | 1.45 | normal | Secondary review metadata |
| Label | `--font-label` | `0.75rem` | 600 | 1.35 | `0.04em` | Short labels, sentence case |
| Code | `--font-code` | `0.8125rem` | 400 | 1.55 | normal | Patch text and identifiers |

At widths below 480px, form inputs remain at least `1rem` to avoid mobile zoom.
Headings use `clamp()` where needed and must wrap rather than truncate. Body copy
stays within 68 characters when it is explanatory rather than tabular.

## 4. Spacing & Layout

All spacing intent uses a 4px base.

| Token | Value | Usage |
|---|---:|---|
| `--space-1` | `0.25rem` | Inline icon/text |
| `--space-2` | `0.5rem` | Compact metadata |
| `--space-3` | `0.75rem` | Control internals |
| `--space-4` | `1rem` | Default gap and mobile panel padding |
| `--space-5` | `1.25rem` | Form groups |
| `--space-6` | `1.5rem` | Desktop panel padding |
| `--space-8` | `2rem` | Section groups |
| `--space-10` | `2.5rem` | Page rhythm |
| `--space-12` | `3rem` | Large separation |

Layout tokens:

| Token | Value | Usage |
|---|---:|---|
| `--content-max` | `76rem` | Showcase and future review workspace |
| `--reading-max` | `42rem` | Form/help copy |
| `--rail-width` | `15rem` | Desktop context rail |
| `--header-height` | `4rem` | Product shell header row |
| `--control-height` | `2.75rem` | Minimum mouse/touch target |
| `--radius-control` | `0.375rem` | Inputs and buttons |
| `--radius-panel` | `0.625rem` | Panels only |
| `--radius-pill` | `999px` | Compact semantic badges only |
| `--line` | `1px` | Borders and row rules |
| `--focus-width` | `0.125rem` | Keyboard focus outline thickness |
| `--focus-offset` | `0.125rem` | Default focus separation from controls |
| `--focus-inset` | `-0.1875rem` | Inset focus treatment inside scroll owners |
| `--state-panel-min` | `13rem` | Stable loading/empty/error panel height |
| `--patch-scrollbar-size` | `0.75rem` | Visible patch scrollbar thickness |
| `--patch-scroll-track-size` | `0.375rem` | Persistent patch position track thickness |
| `--patch-scroll-thumb-min` | `2.5rem` | Minimum visible patch position thumb width |

Responsive thresholds are named contract values even though current CSS media-query
syntax requires their literal values: `--breakpoint-stack` is `48rem`,
`--breakpoint-metadata-single` is `48rem`, and `--breakpoint-mobile` is `30rem`.
The product metadata follows the 48rem value for zoom reflow; the development
showcase keeps its separately approved primitive-grid thresholds.

Spatial model:

- The future desktop review surface uses a `fixed-sidenav-shell`: compact context
  rail, fluid evidence column, and optional decision aside. The bounded context rail
  and evidence column independently own vertical scroll so every control and every
  evidence line remains reachable without moving the product header.
- At 768px the decision aside moves below metadata. At and below 640 CSS pixels all
  primary content, including the review metadata definition list, is exactly one
  document-scrolling column; no fixed rail remains.
- Primitive grids use
  `repeat(auto-fit, minmax(min(18rem, 100%), 1fr))` and explicitly collapse to one
  column at and below 640 CSS pixels so narrow or 200%-zoomed containers cannot
  force page-level horizontal overflow or preserve an unintended two-card row.
- The patch well is the only intentional horizontal scroll owner. It uses a visible
  native scrollbar, text overflow cue, and tokenized visual position track/thumb
  when long lines exist. When the patch fits, the cue says so grammatically and the
  redundant visual track is hidden. The position track mirrors native scroll state
  without replacing the scroll owner. Inset keyboard focus cannot be clipped by
  panel geometry, and the page itself must never scroll horizontally.
- At 200% zoom, evidence metadata becomes one column, button clusters wrap, and no
  fixed-height region clips content.

## 5. Components

### App Shell / Showcase Shell

- **Structure:** skip link, compact header, `<main>`, stacked showcase sections.
- **Variants:** primitive showcase; future authenticated review shell.
- **Spacing:** `--space-4`, `--space-6`, `--space-8`, `--content-max`.
- **States:** normal and constrained-width reflow.
- **Accessibility:** landmark order matches visual order; skip link appears on focus;
  page title is the only `h1`.
- **Motion:** none.
- **Layout:** document scroll for the showcase. Future product shell must explicitly
  name its evidence-column scroll owner.

### Button

- **Structure:** native `<button>` with text and optional inline SVG/spinner.
- **Variants:** primary, secondary, danger, quiet.
- **Spacing:** `--space-2`/`--space-3`; minimum block size `--control-height`.
- **States:** default, hover, active, focus-visible, disabled, loading.
- **Accessibility:** unavailable controls use native disabled semantics; in-flight
  controls expose `aria-busy` and `aria-disabled` while duplicate handlers are ignored
  so the initiating control retains focus. An icon is decorative when visible text
  already names the action. A control that begins an asynchronous action stays focused while busy; if a completed decision disables
  that control, focus moves synchronously to the newly enabled inverse action.
- **Motion:** 120ms color/opacity transition; active uses `translateY(1px)` only.
- **Layout:** `cluster`; controls wrap before overlap.

### Field and Login Form

- **Structure:** visible `<label>`, input, persistent hint/error slot, submit button,
  and plain authentication-scope note.
- **Variants:** text, password; valid, invalid, disabled.
- **Spacing:** `--space-2`, `--space-3`, `--space-5`.
- **States:** default, hover, focus-visible, invalid, disabled, submitting, rejected.
- **Accessibility:** autocomplete attributes; errors use `aria-describedby` and
  `role="alert"`; rejected submit focuses the first invalid field. Authentication
  errors never reveal whether an account exists. Local loading uses `aria-busy`
  without disabling the focused submit button, and duplicate submissions are
  ignored until the local timer completes.
- **Motion:** spinner rotation only; reduced-motion replaces rotation with a static
  `Working` label.
- **Layout:** `stack`, capped by `--reading-max`.

### Status / Approval Badge

- **Structure:** short text plus a small CSS/SVG marker hidden from assistive tech.
- **Variants:** pending, approved, revoked, stale, neutral.
- **Spacing:** `--space-1`, `--space-2`.
- **States:** static semantic state; never interactive.
- **Accessibility:** full state word is always visible; no color-only meaning.
- **Motion:** none.
- **Layout:** inline `cluster`; never truncates the state word.

### Review Metadata

- **Structure:** `<dl>` of label/value pairs for project, repository, protected ref,
  expected head, candidate commit/tree, policy revision, review revision, required
  job-set revision, and reviewer identity.
- **Variants:** compact summary and complete evidence.
- **Spacing:** `--space-2`, `--space-4`, `--space-6`.
- **States:** current, stale (with adjacent explanation), unavailable.
- **Accessibility:** semantic terms; hashes remain selectable; long identifiers wrap
  anywhere without changing the underlying text.
- **Motion:** none.
- **Layout:** intrinsic grid collapsing to one column at narrow widths and 200% zoom.

### Safe Patch Panel

- **Structure:** file header, change-kind badge, `<pre><code>` patch text, optional
  line rows for production. Content must be inserted as text, never `innerHTML`.
- **Variants:** modified, added, deleted, renamed, mode change, symbolic-link change.
- **Spacing:** `--space-3`, `--space-4`.
- **States:** ready, loading skeleton, empty, error.
- **Accessibility:** focusable named scroll region; raw prefixes `+`, `-`, and `@@`
  remain visible so color is redundant; patch is selectable and copyable. A visible
  text cue names horizontal overflow and updates from start to end while scrolling.
  The visual track is hidden from assistive technology because the native region and
  text cue expose the same state.
- **Motion:** loading pulse uses opacity only and stops under reduced motion.
- **Layout:** `stack`; the code well alone owns horizontal scroll.
- **Rendering bound:** patches through 8 MiB and 250,000 lines are complete browser
  evidence. Up to 5,000 lines retain per-line semantic highlighting; larger supported
  patches use one literal text node so DOM growth stays bounded. Evidence above either
  browser limit renders no partial patch and instead shows an explicit full-evidence
  error. Copying the rendered patch must reproduce the API string byte-for-byte in
  UTF-8, including empty lines and final-newline state.

### State Panel

- **Structure:** state heading, plain explanation, and optional recovery action.
- **Variants:** loading, empty, error, stale, blocked.
- **Spacing:** `--space-4`, `--space-6`.
- **States:** selected state appears in place without layout collapse.
- **Accessibility:** loading uses `role="status"`; errors use `role="alert"`; retry
  returns focus to the state heading when complete.
- **Error specificity:** the state heading and recovery copy name the failed action;
  sign-out failures never reuse evidence-request language.
- **Motion:** opacity crossfade only; no movement required.
- **Layout:** centered `stack` within a bounded panel, never a blank card.

### Authenticated Review Workspace

- **Structure:** persistent product header, context rail, create/open controls,
  evidence workspace, changed-path list, literal patch region, and logout action.
- **Variants:** signed out; restoring session; authenticated with no open review;
  creating evidence; loading an exact review; ready; stale; and request error.
- **Authority:** the page can create and read immutable review evidence only. It
  contains no approval, rejection, revocation, promotion, CI-reporting, generic
  proxy, or host-administration control.
- **Data:** the session fixes Project and repository choices. The current review is
  fetched from the member route by the exact returned or entered 64-hex review ID;
  collection responses are not treated as the opened evidence record.
- **Security:** the CSRF token exists only in JavaScript memory. The session cookie
  remains HttpOnly. Browser code never reads native credentials, uses storage APIs,
  interprets Markdown, or inserts API strings as HTML.
- **States:** each network transition keeps a named visible status. Authentication
  rejection is generic; review errors preserve entered refs/ID and offer retry;
  stale evidence keeps the full record visible beside the stale reasons. Entered refs
  and review IDs are preserved only while the same authenticated session can retry.
  Sign-out and session expiry abort active work, discard retry actions, clear every
  rendered review field and form ref/ID, and leave the next authenticated session in
  the empty state until that reviewer explicitly creates or opens evidence.
- **Operation ownership:** restore, login, create, open, retry, and logout share one
  monotonic operation generation and one active `AbortController`. Starting any action
  aborts and supersedes the prior action. Every asynchronous continuation checks that
  its generation is still current before changing visible state, focus, credentials,
  or evidence. Logout therefore cannot be followed by revived stale content.
- **Accessibility:** username/password and ref/review-ID inputs have visible labels;
  successful sign-in moves focus to the workspace heading; logout returns focus to
  the username; exact-review completion moves focus to the evidence heading; errors
  use a single alert region without duplicating announcements. A concise atomic live
  status sits outside evidence content; the metadata and patch are never live regions.
  Rejected credentials mark both credential fields invalid and associate the generic
  error with them. Successful sign-in clears the password value before hiding the form.
- **Layout:** desktop uses `fixed-sidenav-shell`; the bounded context rail and
  evidence workspace are named vertical scroll owners. At `--breakpoint-stack`,
  both rejoin one document-scrolling column. The patch remains the only horizontal
  scroll owner.

## 6. Motion & Interaction

| Type | Token | Duration | Easing | Usage |
|---|---|---:|---|---|
| Immediate | `--motion-immediate` | `80ms` | `ease-out` | Press acknowledgement |
| Micro | `--motion-micro` | `120ms` | `ease-out` | Hover/focus color and opacity |
| State | `--motion-state` | `180ms` | `ease-in-out` | Loading/error content crossfade |
| Spinner | `--motion-spinner` | `700ms` | `linear` | Busy indicator rotation |
| Skeleton | `--motion-skeleton` | `1.2s` | `ease-in-out` | Loading placeholder opacity |

- Motion explains interaction or state only. There are no entrance cascades,
  decorative glows, parallax, or auto-playing transitions.
- Animate only `transform` and `opacity`; color transitions may use the browser's
  paint path because they do not alter layout.
- `prefers-reduced-motion: reduce` removes transforms, rotation, pulsing, smooth
  scrolling, and transition delay. Busy meaning remains in text and static geometry;
  no animation is required to understand state.
- Focus uses a 2px `--color-focus` outline plus a canvas offset. Hover never carries
  information that is absent at rest.
- Approval/revocation must revalidate the exact review on the server in production.
  The showcase may demonstrate state transitions but must label them as local demos.

## 7. Depth & Surface

Use a mixed strategy dominated by tonal shift and explicit borders:

| Level | Treatment | Usage |
|---|---|---|
| Canvas | `--color-canvas` | Deepest page background |
| Shell | `--color-shell` + subtle bottom border | Persistent chrome |
| Panel | `--color-panel` + `--color-border-subtle` | Grouped primitives |
| Elevated | `--color-elevated` + `--color-border` | Inputs and selected controls |
| Recessed | `--color-recessed` + inset `0 0 0 1px` subtle border | Evidence and patch wells |

No ambient gradients, glass blur, large shadows, or floating card stacks. A tiny
`0 1px 2px rgba(0,0,0,0.18)` shadow is allowed only for a future popover and must
be tokenized before use. Panels use at most `--radius-panel`; buttons never use pill
geometry. Trust and status badges may be pills because their compact shape carries a
semantic grouping job.

## 8. Accessibility Constraints & Accepted Debt

### Constraints

- Target WCAG 2.2 AA: 4.5:1 for normal text, 3:1 for large text and component
  boundaries, and a visible 2px focus indicator on every interactive control.
- Full keyboard operation follows DOM order; no positive `tabindex`, keyboard trap,
  hover-only action, or focus loss after state changes. Focus transfer after approval
  and revocation lands on the newly enabled inverse action; login retains focus on
  its busy submit control and restores the same control after completion.
- Minimum target size is 44 by 44 CSS pixels. At 200% browser zoom the primary task
  remains operable without two-dimensional page scrolling.
- Plain language wins over terse system codes. Errors state what happened, what was
  preserved, and the next safe action without exposing credentials or arbitrary
  backend payloads.
- Patch data, paths, identities, commit messages, and controller-provided text are
  untrusted. Render them through text nodes or escaped server templates, never as
  HTML or interpreted Markdown. Screenshots and logs must not include secrets.
- Status cannot rely on color, animation, icon, or position alone. Loading, empty,
  error, stale, revoked, and blocked are named in text.
- Honor `prefers-reduced-motion`, `prefers-contrast`, and forced colors. Keep native
  control semantics and allow user zoom; never set a maximum scale. Forced-colors
  mode uses system colors for focus, controls, status markers, and patch boundaries;
  semantic text and patch prefixes preserve meaning when custom fills disappear.
  The selected state-preview control alone preserves its authored high-contrast
  foreground/background pair because Chromium's automatic forced-color repaint can
  replace its visible text glyphs with an opaque inset.
- Long paths, names, hashes, and localized strings must wrap or scroll in their
  named region without clipping. CJK text receives normal line-height and no fixed
  character-width assumptions outside code. The showcase includes a local CJK
  stress mode covering Korean, Japanese, and Chinese strings; fallback fonts must
  render every character without tofu or clipped baselines.
- Persona pass criteria: a keyboard-only reviewer can sign in, inspect exact review
  metadata, traverse the patch, identify stale/blocking state, and reach the action;
  a low-vision reviewer can do the same at 200% zoom; an incident responder can
  distinguish evidence from authority without inferred CI/merge/promotion state.

### Accepted Debt

| Item | Location | Why accepted | Owner / Exit |
|---|---|---|---|
| Automated screen-reader announcement audit is not part of the showcase harness | Primitive showcase only | Browser accessibility tree and keyboard behavior are exercised now; production framework and test runner are not selected | Add automated accessibility and assistive-technology coverage with the product package |
| Light color scheme is not defined | Design system | The first reviewer console is dark-mode-only by scope; mechanical inversion would be unsafe | Define and contrast-test a full semantic light mapping before offering a theme switch |
| Approval and rejection decisions are absent | Product workspace | The owner has not resolved whether reject creates durable evidence or revokes an existing approval; exposing either label would invent authority | Add a decision control only after the normative action and API are approved |
