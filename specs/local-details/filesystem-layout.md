# Filesystem Layout

## State Root

The normalized `stateRoot` contains persistent infrastructure state.

```text
<stateRoot>/
  jobs/
  git-host/
  controller/
```

## Job State

For job ID `<jobId>`:

```text
<stateRoot>/jobs/<jobId>/
  disk.img
  metadata.json
```

`disk.img` exists for loopback jobs.
It may be absent for directory storage jobs.

`metadata.json` contains:

```json
{
  "jobId": "job-1",
  "profileName": "default",
  "resourceProfile": {},
  "storageBackend": "loopback",
  "paths": {},
  "createdAt": "2026-07-03T00:00:00.000Z",
  "mounted": true
}
```

## Job Mount Root

For job ID `<jobId>`:

```text
<jobMountRoot>/<jobId>/
  workspace/
  runtime-data/
```

`workspace` is mounted into the agent at `agent.workspacePath`.

`runtime-data` is mounted depending on backend:

- Sysbox: `agent.runtimeDataPath`, default `/var/lib/docker`.
- gVisor: `agent.runtimeDataPath`, default `/var/lib/docker`.
- Rootless Podman: `/home/agent/.local/share/containers`.

## Managed Git Host

```text
<stateRoot>/git-host/
  repos/
    <repo>.git/
  prs/
    <repo>/
      <id>.json
```

## Controller

```text
<stateRoot>/controller/
  secret-runtime.json
  secret-runtime.lock/
```

`secret-runtime.lock` is a directory used as an atomic lock.

## Temporary Paths

Secret deployment creates temporary worktrees under the host temp directory:

```text
/tmp/dim-secret-deploy-*
```

Doctor loop checks create temporary directories:

```text
/tmp/dim-loop-check-*
```

These paths must be removed after use.
