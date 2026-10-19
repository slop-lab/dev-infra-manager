# Root monorepo

DIM is developed, tested and built from one root repository. The source commit
identifies the full package/plugin/test tree; separately packed packages retain
that shared source identity. There is no required sibling checkout.

Production ownership and package names are documented in the
[repository layout](repository-layout.md). Host core owns workspace lifecycle,
controller and plugin composition. Feature implementations live in explicit
host or control-plane plugins. Neutral contracts have no concrete runtime
implementation dependencies.

One `@this-project/tests` workspace owns behavior tests and cross-component
scenarios. Shared runners live in `scripts/checks/`. A workflow plugin compiles
repository configuration into a neutral execution plan; Git authority does
not interpret workflow languages. Shared services run in the standalone
control-plane runtime without host core.

Installation selects the transitive closure of requested components from a
matched bundle. The existence of an optional artifact does not activate it.
The installer facade remains the supported installation boundary; internal
package exports and storage protocols can change together during development.

The same one-container workspace develops DIM and other repositories. Coding
agent tools and repository tasks are workspace user code. There is no required
trusted outer lifecycle, rootless sidecar daemon or automatic host hook.
See [self-development boundaries](self-development-boundaries.md).

Optional managed review and CI operate on exact candidate bytes. Protected-ref
promotion, host installation, public tags and package publication have distinct
roles. Internal test evidence does not publish or approve the candidate.
