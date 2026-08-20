# cgroupfs delegation

Use this provider when a trusted parent container manager owns a writable
cgroup v2 subtree directly. The parent must place the workspace inside its
aggregate resource boundary before Project code runs.

Reviewed setup checks the core-published driver and creates only its named
descendant:

```bash
sudo dim-project-cgroup require
sudo dim-project-cgroup create agent-dind 1000 1000 cpu memory pids
```

The returned path may be mounted into the Project-owned runtime. Do not mount
the host cgroup root and do not give an agent write access to the workspace's
aggregate `cpu.max`, `memory.max`, or `pids.max` files.

See [`verify.bash`](verify.bash) for the executable contract check.
