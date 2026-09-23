# @slop-lab/dim-control-plane

Optional provider-specific remote control plane for DIM. This package owns the
managed Gitea and CI implementation and is not a dependency of the local core
or CLI packages.

Run its bounded SSH entrypoint as:

```bash
DIM_CONTROL_PLANE_PROPOSAL_FILE=/var/lib/dim/proposals/next.json \
  dim-control-plane broker stdio
```

The command accepts one provider-neutral poll request on stdin and writes one
strict schedule proposal on stdout. SSH authentication and command restriction
are operator-owned deployment prerequisites. The package does not edit host
SSH keys or receive the local DIM admin socket.
