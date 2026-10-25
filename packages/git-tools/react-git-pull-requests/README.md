# @slop-lab/react-git-pull-requests

Controlled React pull request presentation with no DIM, network or account
integration. Uses the portable pull-request, discussion, blame, and diff models
with `@slop-lab/react-git-diff`. React and React DOM are peers.

`PullRequestPanel` receives `pullRequests`, `selected`, and `snapshot`. The diff
must match the selected revision's exact base and head commits. Otherwise it
shows an unavailable message and cannot create stale line anchors. Switching
pull request or revision clears local edit drafts, line selection and blame.

`mountPullRequestPanel(container, props)` returns `update(nextProps)` and
`unmount()` for applications using ordinary DOM panels. Bundle the ESM entry
with your application. Source text, comments and metadata are rendered as text.

All mutation callbacks are optional; their absence hides unavailable actions:

- `onSelect(id)`, `onRefresh()` and `onCreate({title,body,sourceRef,targetRef})`
- `onEdit({title,body})`, `onSetState('open'|'closed')`
- `onComment({revisionId,body,anchor?:{path,side,line}})`
- `onPrepareReview()`, `onApprove()`, `onRevoke()`, and `onMerge()` with
  independently controlled disabled states
- `onBlame(immutableDiffLineAnchor)` returning the validated
  `@slop-lab/git-blame` line attribution
- `onInspectDiff({baseCommit,headCommit})` and
  `onInspectBlame({commit,path,line})` for direct inspection without a pull request

Callbacks may return promises. Local pending feedback prevents repeated actions,
errors remain visible, and failed forms retain their input. The application owns
the authoritative data and must call `update` after accepted mutations. A
callback must not report an accepted mutation as a failed action merely because
a subsequent refresh failed: refresh separately, then supply the resulting view
or a visible loading/error state. No client-side callback replaces server
permission checks or optimistic concurrency control.

`reviewStatus` supplies plain status text and `reviewContent` accepts independent
React content. Approval and merge decisions are supplied by the adapter; this
package does not infer policies. General comments and old revision comments are
shown in Discussion; current line comments appear below their matching diff
line. All old revision comments carry an explicit outdated label. Blame is an
optional callback and never changes the stored comment anchor.

Load the optional `@slop-lab/react-git-pull-requests/styles.css` and
`@slop-lab/react-git-diff/styles.css` stylesheets, or supply your own semantic
`git-pr` / `git-diff` classes. No inline styles are emitted; an application can
serve both as external assets under strict CSP. `className` appends a custom root
class. All draft fields and line selection are disabled while an action is
pending, so an accepted mutation cannot erase newly entered text or anchors.
