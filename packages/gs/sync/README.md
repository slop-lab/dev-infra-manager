# @slop-lab/gs-sync

Independent upstream fetch, merge-proposal creation and authoritative protected
commit publication. The service composes a repository mutation gate, an
explicit proposal consumer and a real-Git transport. It never reads
`.dim/repos.yml`, invokes CI or review, approves, or promotes. Upstream rewrite
protection, the `dim-git-sync-v1` principal digest and proposal ref bytes remain
stable. HTTP Basic/operator configuration stays in embedding adapters.
