# Authority and lifecycle responsibilities

This document describes current responsibilities. Internal protocol versions
and retired runtime layouts are not compatibility requirements.

| Owner | Allowed authority | Boundary |
| --- | --- | --- |
| Host operator | Install components, configure hosts/services, choose runtime images and capacity | Explicit operator input; candidate files grant no host authority |
| Core workspace application | Create, observe, execute, stop/recreate/discard owned workspace resources | Immutable UUID, parsed record, per-workspace lock, exact ownership labels |
| Workspace | Modify checkout/home/private Docker and run development services | No host Docker socket, host checkout bind or reusable host role credentials |
| Managed Git broker | Read registered source and push one workspace proposal namespace | Scoped attachment and grant, live core UUID/state validation, private host listener |
| Git authority | Own repositories, proposal evidence and protected refs | Protected writes use current policy, selected evidence, human decisions and atomic ref update |
| Execution | Lease jobs, fence capacity, report candidate-bound results | No review, promotion, importer or general host authority |
| Human reviewer | Inspect exact candidate evidence, approve or revoke | Approval binds the reviewed tuple and policy; CI is not approval |
| Controller plugin | Serve explicitly enabled scoped routes and constrained inputs | Current core workspace UUID/state and target ownership checked at use |
| Installer facade | Acquire exact components, promote installation, activate and recover | No implicit workspace or protected-ref mutation |

A workspace name is a display identifier. Creating the same name after discard
produces a new UUID; old grants and listeners cannot resolve to that workspace.
Recreate preserves UUID and selected data but replaces runtime realization.
Missing or foreign resources fail ownership validation. Failed cleanup remains
recorded for explicit retry rather than allowing accidental resource adoption.

Managed source acquisition shares the core runtime. There is no trusted outer
container, two-level agent topology or separate managed workspace state machine.
The scoped broker checks the current record and only supports the registered
repository's Git operations; it is not a generic HTTP proxy or administration
endpoint. Host role credentials stay outside the workspace.

Project readiness establishes registered source ownership and usable source
access. It requires neither CI availability nor a proposal approval. A protected
ref may advance while an existing workspace keeps its mutable checkout; reads
may follow a proven fast-forward under the same Project/ref/policy. No lifecycle
operation overwrites local work to enforce the latest protected commit.

Execution slots remain fenced after lease expiry until cleanup is confirmed.
Terminal results are durably accepted independently of publication back to Git;
a Git outage must not hold cleaned capacity indefinitely. Evidence must bind
the exact candidate and current attempt. Retries and stale workers cannot
replace newer results or obtain protected-ref authority.

Optional published service routes resolve the current owned agent and, when
requested, one target in its private Docker daemon. Each new HTTP request,
WebSocket upgrade or TCP connection revalidates workspace authority. Cached IPs
and display-name reuse are not authentication. Host administration uses a
separate private socket; there is no automatic host socket mount into agents.
