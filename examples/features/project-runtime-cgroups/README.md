# Project runtime cgroups

DIM publishes the nested Project engine's cgroup boundary in
`/run/dim/project.json` and installs `dim-project-cgroup` in the standard
workspace image. Reviewed Project setup can require that boundary and create a
named subtree without learning a host cgroup path.

The variants below show the supported driver-specific contracts:

- [`cgroupfs`](cgroupfs/README.md): a trusted parent delegates a writable
  cgroup v2 subtree directly.
- [`systemd`](systemd/README.md): systemd owns the service boundary and grants
  its descendants with `Delegate=`.
- [`unsupported`](unsupported/README.md): `none`, cgroup v1, read-only roots,
  and missing controllers fail closed with an actionable reason.

These are boundary examples, not alternative Project formats. Ordinary
Projects consume the same manifest and helper regardless of the provider.

Run the contract smoke with:

```bash
bash scripts/project-runtime-cgroups-example-smoke.bash
```
