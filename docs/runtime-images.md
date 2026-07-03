# Runtime Images

## Agent Workspace Image

The included agent workspace image lives in [images/agent-workspace](../images/agent-workspace).

Build it with:

```bash
just build-agent-image
```

The image is tagged as:

```text
dev-infra-agent-workspace:latest
```

The image is based on Docker-in-Docker and is intended to run under Sysbox, not as a privileged host-Docker-socket container.

Runtime expectations:

- `/workspace` is bind-mounted from the per-job quota filesystem.
- `/var/lib/docker` is bind-mounted from the same per-job quota filesystem.
- The image starts an inner Docker daemon by default.
- Set `DEV_INFRA_START_DOCKERD=0` for simple command smoke tests that do not need nested containers.
- The final command runs as the `agent` user.

## Secret Runtime Example Image

The included secret runtime example lives in [images/secret-runtime-example](../images/secret-runtime-example).

Build it with:

```bash
just build-secret-example
```

The image is tagged as:

```text
dev-infra-secret-runtime:latest
```

It exposes a minimal HTTP health endpoint on port `7090`.

This image is only an example trusted runtime target. Project-specific secret runtimes should live in reviewed Git refs and be deployed through `secret deploy` or the controller.
