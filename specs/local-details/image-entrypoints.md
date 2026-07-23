# Image Entrypoints

## Docker Agent Image

Path:

```text
images/agent-workspace
```

Base image:

```text
docker:29.1.3-dind
```

Entrypoint:

```text
/usr/local/bin/dev-infra-agent-entrypoint
```

Startup behavior:

1. Create `/workspace`, `/var/lib/docker`, `/var/run`, and `/home/agent`.
2. Set ownership for `/workspace`, `/home/agent`, and `/var/lib/docker` to `agent:agent`.
3. If `DEV_INFRA_START_DOCKERD` is `1` or unset, start `dockerd`.
4. Start `dockerd` with:
   - `--host=unix:///var/run/docker.sock`
   - `--data-root=/var/lib/docker`
   - `--group=agent`
   - plus `DEV_INFRA_DOCKERD_FLAGS`
5. Wait up to 60 seconds for `docker info`.
6. Set `/var/run/docker.sock` group to `agent` and mode to `0660`.
7. Default command to `bash` if none is supplied.
8. Execute final command as `agent` with `HOME=/home/agent`.

The image sets:

```text
DOCKER_TLS_CERTDIR=
DOCKER_HOST=unix:///var/run/docker.sock
```

## Podman Agent Image

Path:

```text
images/agent-workspace-podman
```

Base image:

```text
quay.io/podman/stable:v5.6.2
```

Entrypoint:

```text
/usr/local/bin/dev-infra-agent-podman-entrypoint
```

Startup behavior:

1. Create `/workspace`, `/home/agent/.local/share/containers`, and `$XDG_RUNTIME_DIR`.
2. Set ownership for `/workspace`, `/home/agent`, and `$XDG_RUNTIME_DIR` to `agent:agent`.
3. Set `$XDG_RUNTIME_DIR` mode to `0700`.
4. Default command to `bash` if none is supplied.
5. Execute final command as `agent` with `HOME=/home/agent`.

The image sets:

```text
DEV_INFRA_NESTED_ENGINE=podman
DEV_INFRA_START_DOCKERD=0
XDG_RUNTIME_DIR=/tmp/agent-runtime
```

## Secret Runtime Example Image

Path:

```text
images/secret-runtime-example
```

Behavior:

- Runs Node.js HTTP server.
- Listens on `PORT`, default `7090`.
- `GET /healthz` returns a JSON health response.
- Other paths return `404`.
