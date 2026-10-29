# @slop-lab/gs-pull-request-service

Independent durable pull-request lifecycle, immutable revision pins and
conversation mutation over neutral repository gates. Review is an optional
injected `ReviewRequest` capability; create, edit, refresh, list and comments do
not require review, CI or promotion. Callers inject typed principal scopes and
an explicit owned-ref writer. Existing record bytes and
`refs/dim/extensions/git-pull-requests/` names remain stable.
