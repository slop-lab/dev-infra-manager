# Remote control-plane fixture

This fixture demonstrates the final local/remote contract without installing
DIM on the host or containing production credentials.

1. Copy `local.example.json` outside the checkout and replace every absolute
   path with operator-owned paths.
2. Create the SSH key and pinned `known_hosts` entry out of band. Do not use
   these example names as credentials and do not change host `authorized_keys`
   through DIM.
3. Review the complete tree represented by `approval.example.json`, including
   the aggregate digest, path patterns, and capability ceiling.
4. Run `dim approve --config LOCAL approval.example.json`.
5. Place `proposal.example.json` in the remote provider queue and run
   `dim run-remote --config LOCAL --request-id request-1 project-1`.

The remote response cannot carry a command. The local configuration maps the
approved `unit-tests` workload ID to an operator-selected executable.
