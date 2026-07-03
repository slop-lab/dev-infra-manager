# Resource Isolation

## Container Isolation

Sysbox is the default container runtime for agent workspaces because agents need to create nested containers without receiving access to the host container runtime. gVisor and rootless Podman backends are available for hosts where Sysbox cannot run.

Required isolation properties:

- Do not mount the host Docker socket into agent containers.
- Do not run agent workspace containers as privileged containers.
- Run nested containers inside the agent workspace boundary through the selected backend.
- Keep secret-bearing containers outside the agent workspace boundary.
- Keep secret-bearing volumes unavailable to agent containers and nested containers.
- Apply resource limits at the agent workspace level so nested workloads cannot exceed the job budget in aggregate.

The default production runtime assumes Sysbox host support and KVM availability. Environments without KVM can use the `gvisor` backend when `runsc` is available, or the `rootless-podman` backend when workloads can use Podman instead of Docker-in-Docker.

## Resource Limits

The infrastructure must support user-controlled resource limits for agent jobs.

Resource limits apply to the agent workspace container and must constrain nested workloads in aggregate.

Supported limit categories:

- CPU.
- Memory.
- Process count.
- Disk usage.
- Job runtime.

Nested containers may also receive individual limits, but the agent workspace container remains the outer enforcement boundary for the whole job.

Job runtime is enforced by wrapping agent container execution with the host `timeout` command. CPU, memory, and process limits are passed to Docker for the outer agent workspace container.

## Disk Quota

Disk quota is enforced at the job boundary.

Each agent job receives a quota-limited filesystem created by the host controller. The controller creates a per-job disk image, formats it, mounts it on the host, and passes directories from that mounted filesystem into the agent workspace container.

The quota-limited filesystem contains:

- The agent workspace.
- The nested container runtime data root.
- Image layers, build cache, writable layers, and generated artifacts produced inside the job.

This makes disk usage from the agent workspace and nested containers count against the same job quota. Individual nested containers may still receive separate limits, but the per-job filesystem is the aggregate disk boundary.

The controller tears down the per-job filesystem after the job completes. Only explicitly exported artifacts or Git-pushed changes are preserved.

The default implementation uses per-job loopback filesystems for disk quota enforcement. Future implementations may replace this with project quota, LVM thin pools, ZFS datasets, or btrfs subvolume quotas while preserving the same job-level quota model.

The `directory` storage backend exists for constrained nested environments that cannot create loop devices. It creates ordinary directories and does not enforce `diskBytes`. Use it only with an external disk quota or for development checks where aggregate disk enforcement is not required.
