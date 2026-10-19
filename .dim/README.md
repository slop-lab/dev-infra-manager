# DIM-recognized Project configuration

| File | Reader |
| --- | --- |
| `repos.yml` | Optional native Git Project root-policy loader |
| `ci/runner.yml` | Optional CI workflow plugin; job payloads live in [`scripts/ci`](../scripts/ci) |
| `README.md` | Human documentation only; DIM does not parse it |

The reviewed configuration files grant no host authority and do not start
development tasks automatically. Ordinary repositories need none of them.

Developer commands live in [`scripts/development.md`](../scripts/development.md) and `scripts/dev.bash`.
Host-run QEMU verification mechanics live in [`verification/qemu`](../verification/qemu).
Those helpers are explicit repository tooling, not DIM Project configuration.
