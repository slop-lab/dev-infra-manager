# Unsupported cgroup boundary

DIM reports an unavailable boundary instead of accepting an ineffective
resource contract when:

- the nested engine reports cgroup driver `none`;
- the workspace does not expose cgroup v2;
- the namespace root is read-only; or
- the required `pids` controller is absent.

Reviewed setup should fail before starting Project services:

```bash
dim-project-cgroup require
```

See [`verify-unsupported.bash`](verify-unsupported.bash) for the negative
contract check.
