# @slop-lab/dim-core

Provider-neutral local authority for DIM. It parses the strict remote scheduling
protocol, records explicit operator approvals, admits an exact complete tree
under path and capability ceilings, polls an authenticated SSH broker, and
executes only locally registered workload IDs.

The package contains no Git-provider or CI-manager implementation. Install
`@slop-lab/dim-control-plane` only on the remote control-plane host.

The SSH client requires an operator-created private key and a pinned
`known_hosts` file. It disables forwarding, agent use, PTYs, local commands,
and interactive authentication. DIM never edits `authorized_keys`.
