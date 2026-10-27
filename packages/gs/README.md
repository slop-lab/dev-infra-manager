# Git service source owner

This is the temporary, movable source root for the future Git project. It is
not a new external repository, deployment profile, published release or full Web
application. Its build configuration, compiler tool and license are contained
here. The private `@this-project/gs-workspace` package is tooling, not a product
or an installed plugin.

| Package | Ownership |
| --- | --- |
| `@slop-lab/gs-repository` | Git executable/storage integrity, smart-HTTP transport, repository-scoped grants and protected-ref ordering |
| `@slop-lab/gs-diff` | Unified diff parsing and immutable anchors |
| `@slop-lab/gs-blame` | Attribution models and porcelain parsing |
| `@slop-lab/gs-discussions` | Revision/line comment models |
| `@slop-lab/gs-pull-requests` | PR revision/lifecycle models; depends on discussions, not human review or CI |
| `@slop-lab/gs-react-diff` | Controlled diff presentation |
| `@slop-lab/gs-react-pull-requests` | Controlled PR presentation with optional callbacks and CSS |
| `@slop-lab/gs-review-tracing` | Neutral tracker, snapshot comparison and detector runtime contracts |
| `@slop-lab/gs-review-tracing-node` | Optional isolated Node detector evaluator |

Packages are composable dependencies, not a fixed ladder or mandatory bundle.
Separate packages do not require separate processes. Repository hosting does
not import review, PR, comments, CI, a scheduler or the React packages.

## Build outside DIM

Copy this source root as a whole, install its declared development dependencies
with the pinned package manager, then run:

```sh
pnpm install
pnpm run build
pnpm run check
```

`GS_BUILD_VERSION` optionally supplies an explicit artifact version. DIM's
source-bundle scripts translate their aggregate version at the outer composition
boundary; GS code never reads DIM build configuration. Artifacts are generated
in each package's `dist`; no publication occurs during build.

## Current boundary and remaining work

DIM-specific registration, activation, workspace/Project mapping, admission
credentials, `.dim/repos.yml` interpretation, CLI/Web shell integration and
scheduler/worker placement stay in DIM-owned adapters. They depend inward on GS.
The temporary DIM repository service retains its existing format-12 database,
import proofs and durable journal; GS owns the protected-ref algorithm through
typed target, journal and policy ports.

Standalone repository hosting is operational. Standalone durable protected
promotion is not supplied yet: it needs an independent durable journal and
repository catalog/policy owner. The optional service review/PR/CI/sync plugins
still use DIM's repository extension runtime; Git/CI contracts and the service
client still mix DIM transport/configuration with domain data. Those are explicit
remaining cuts, not compatibility forwarding packages or extraction-ready claims.
The Node evaluator is implementation-independent but still implements the
canonical `dim:review` detector API and existing Docker ownership identities.
Its public naming transition is not claimed complete; no alternate alias is
introduced. Stored tracing digest domains remain unchanged.

Tests and fixtures remain in the monorepo's central `tests/` workspace. The
standalone repository test copies this owner's build inputs and repository
package outside DIM and runs real Git HTTP without DIM registration or state.
