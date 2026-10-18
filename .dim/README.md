# DIM-recognized Project configuration

`repos.yml` declares the optional native Project root policy. `ci/runner.yml`
describes candidate-controlled CI jobs; its executable payloads live in
[`scripts/ci`](../scripts/ci). DIM reads
these reviewed configuration files; they grant no host authority and do not
start development tasks automatically.

Developer commands live in [`scripts/development.md`](../scripts/development.md) and `scripts/dev.bash`.
Host-run QEMU verification mechanics live in [`verification/qemu`](../verification/qemu).
Those helpers are explicit repository tooling, not DIM Project configuration.
