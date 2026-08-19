# Feature example: delegated agent tool cgroups

A Project can keep a lightweight agent management path responsive while a
coding agent and its tool processes consume CPU or process slots. DIM applies
the hard aggregate CPU, memory, and PID limits to the trusted workspace; the
reviewed Project lifecycle may create stricter threaded children beneath that
boundary.

The repository's canonical `.dim/` is the runnable example. Its setup creates
`tools-0` through `tools-3`, delegates only `cpu.weight`, `pids.max`, and
thread placement to the unprivileged agent, and mounts only that subtree at
`/run/dim/cgroup`. The Compose service uses the trusted workspace's cgroup
namespace so those paths identify real descendants of the workspace group.

`.dim/entrypoint.sh` leaves the `bash` task in the service's default group and
wraps only Codex:

```sh
dim-tool-cgroup tools-0 \
  codex --dangerously-bypass-approvals-and-sandbox
```

Children inherit the calling thread's group, so shells and other tools started
by Codex stay with it. A Project can tune the delegated group without granting
access to the workspace parent:

```sh
echo 25 > /run/dim/cgroup/tools-0/cpu.weight
echo 256 > /run/dim/cgroup/tools-0/pids.max
```

This is CPU/PID scheduling isolation, not a new memory boundary. Cgroup v2
threaded children cannot receive memory or I/O domain controllers; those
resources remain governed by the workspace-wide limits. Pre-create a fixed
number of slots in trusted setup code instead of letting the agent create
arbitrary hierarchy outside its delegated subtree.

Run the linked end-to-end verification with:

```bash
just verify self-development
```
