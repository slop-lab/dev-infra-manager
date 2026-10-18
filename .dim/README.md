# Explicit repository development tasks

The repository runs in the ordinary slim DIM workspace. It does not define a
second privileged Project runtime, automatic lifecycle hooks or a private
agent/secure Docker topology.

```bash
dim create /path/on/selected/host/to/dev-infra-manager dev
dim exec dev -- bash .dim/dev.bash setup
dim exec dev -- bash .dim/dev.bash check
dim exec dev -- bash .dim/dev.bash tool-setup codex
dim exec dev -- bash .dim/dev.bash agent codex
```

`setup` installs pinned workspace dependencies. `check` builds, checks and tests
them. Tool installation is an explicit separate task using the existing
user-home installer. `shell` and `web` run inside this same untrusted workspace;
use `dim forward` for a selected service port.

`ci/runner.yml` and its scripts define candidate-controlled CI jobs. `repos.yml`
is the optional native Project root policy. Neither file grants host authority
or causes automatic development setup.

The `qemu-*` files are retained host-run verification mechanics used by the
explicit physical KVM gates under `verification/`. They are not started by
workspace creation and are not installed into the development container as a
privileged service. Run those gates only with their documented operator and
hardware prerequisites.
