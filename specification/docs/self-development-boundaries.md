# Developing DIM inside DIM

DIM can develop its own monorepo from an ordinary Git source, or optionally
from a registered managed Project. Both use the same unprivileged Sysbox agent,
persistent checkout/home/private Docker data and local/SSH host application.
The repository's development scripts run inside that workspace; they are not
trusted host lifecycle hooks.

The complete tree is available for editing and building. `core/packages/` owns
production packages, `plugin-*/` owns optional integrations, `tests/` contains
centralized behavior tests, and `verification/` contains cross-component and
physical runtime checks. Package builds select their actual dependency closure.
Directory layout does not grant separate deployment or protected-ref authority.

Workspace processes receive neither the host Docker socket nor reusable host
control-plane roles. A managed source uses a scoped broker for repository reads
and its proposal namespace. Review decisions, protected-ref updates, installer
activation, registry publication and public release remain outside candidate
code. A green candidate-controlled test run does not approve its own source.

Use disposable names and exact owned resources when checking runtime changes.
Source validation does not upgrade the host's running DIM installation. Test
packages and image closures from a matched build before explicitly deploying
that source. Ordinary runtime, SSH, optional Git, browser, Sysbox CI and KVM
checks establish different behavior and should be reported separately.
