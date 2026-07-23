# Docker Command Shapes

## Agent Command

The agent command is generated as:

```text
timeout <timeoutSeconds>s docker run <backend args> <image> <command...>
```

Common Docker args:

```text
run
--cpus <cpuCount>
--memory <memoryBytes>
--pids-limit <pidsLimit>
```

If the backend has a Docker runtime:

```text
--runtime <dockerRuntime>
```

Each backend capability becomes:

```text
--cap-add <capability>
```

Each backend mount becomes:

```text
--mount type=bind,source=<source>,target=<target>
```

Optional name:

```text
--name <name>
```

Default removal:

```text
--rm
```

Environment order:

1. Backend env.
2. `agent.env`.
3. `agent.gitEnv`.
4. Runtime call `extraEnv`.

Later entries with the same key override earlier entries before args are emitted.

Each env entry becomes:

```text
--env KEY=value
```

## Sysbox Args

Expected markers:

- `--runtime sysbox-runc`
- Workspace mount to `/workspace` by default.
- Runtime data mount to `/var/lib/docker` by default.
- `DEV_INFRA_NESTED_ENGINE=docker`
- `DEV_INFRA_START_DOCKERD=1`

## gVisor Args

Expected markers:

- `--runtime runsc`
- Capability additions listed in the runtime backend spec.
- Workspace mount to `/workspace` by default.
- Runtime data mount to `/var/lib/docker` by default.
- `DEV_INFRA_NESTED_ENGINE=docker`
- `DEV_INFRA_START_DOCKERD=1`
- `DEV_INFRA_DOCKERD_FLAGS=--feature containerd-snapshotter=false`

## Rootless Podman Args

Expected markers:

- `--runtime runc` by default.
- Workspace mount to `/workspace` by default.
- Runtime data mount to `/home/agent/.local/share/containers`.
- `DEV_INFRA_NESTED_ENGINE=podman`
- `DEV_INFRA_START_DOCKERD=0`
- `XDG_RUNTIME_DIR=/tmp/agent-runtime`

## Secret Runtime Commands

Secret runtime deploy uses these Docker command shapes:

Build:

```text
sudo docker build --pull --tag <image> --file <dockerfile> <context>
```

Remove previous container:

```text
sudo docker rm --force <containerName>
```

Removal failure is allowed.

Run:

```text
sudo docker run --detach --name <containerName> --restart unless-stopped [--publish <publish>] [--env-file <envFile>] <image>
```

## Shell Rendering

Dry-run and `agent run-command` render commands with shell quoting.
Values containing characters outside `[A-Za-z0-9_./:=@%+-]` are single-quoted, with embedded single quotes escaped.
