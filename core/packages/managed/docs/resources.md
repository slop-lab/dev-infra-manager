# Workspace resources

Ordinary Git and managed Git workspaces share one resource policy. CPU,
memory and PID limits apply to the single unprivileged Sysbox container,
including its nested Docker engine. There is no second container or budget
split. The host needs headroom for Docker, DIM and any optional service or CI
worker running beside workspaces.

Use `dim resources NAME --cpus 4 --memory 8g --pids 4096`. Omitted values remain
unchanged. Each value also accepts `unlimited`. DIM verifies Docker's accepted
limits before saving the new record. Failure restores the prior runtime
configuration where possible and reports a failed restoration explicitly.
Some transitions to unlimited require container recreation; the command
reports that outcome, and persistent home, checkout and Docker data survive.

The core record is the operator's resource assignment. Workspace processes can
inspect their container's limits without receiving a host controller or Docker
socket. Optional plugins may expose narrower resource information, but are not
required to start or configure a workspace.

DIM does not enforce per-workspace disk quotas. Three UUID-owned named volumes
hold home, checkout and nested Docker data. Recreate retains them; discard
removes them. Back up required files before discard, and monitor host Docker
storage separately. DIM never imports a source repository as a writable host
bind mount into the development workspace.
