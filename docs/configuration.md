# Configuration

Persistent workspace lifecycle settings use `DIM_*` environment variables and
workspace metadata. Runtime backend selection is documented in
[Runtime Backends](runtime-backends.md).

`dev-infra.config.json` remains for the legacy bare-Git review controller and
secret-runtime deployment boundary. It contains:

- `stateRoot`: controller and review metadata directory.
- `managedGitHost`: bare Git remote and protected refs.
- `secretRuntime`: approved ref, build context, image, container, env file,
  and published ports.

It does not configure workspace runtime, resource profiles, timeouts, job
storage, or disk quotas.

Generate an example:

```bash
dim init-config --output dev-infra.config.json
dim config validate --config dev-infra.config.json
```
