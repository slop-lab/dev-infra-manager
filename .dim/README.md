# DIM-recognized Project configuration

| File | Reader |
| --- | --- |
| `repos.yml` | Optional native Git Project root-policy loader |
| `ci/runner.yml` | Optional CI workflow plugin; job payloads live in [`scripts/ci`](../scripts/ci) |
| `workspace.json` | Selected-host CLI composition; exact required plugin packages, with explicit installation approval |
| `README.md` | Human documentation only; DIM does not parse it |

The reviewed configuration files grant no host authority and do not start
development tasks automatically. Ordinary repositories need none of them.
`workspace.json` supports only `{"plugins":["PACKAGE@EXACT_VERSION"]}`;
missing plugins stop creation before any workspace record or runtime exists.
An interactive operator may approve installation on the selected host. Paths,
URLs, version ranges and executable hooks are not declaration inputs.

Developer commands live in [`scripts/development.md`](../scripts/development.md) and `scripts/dev.bash`.
Host-run QEMU verification mechanics live in [`verification/qemu`](../verification/qemu).
Those helpers are explicit repository tooling, not DIM Project configuration.
