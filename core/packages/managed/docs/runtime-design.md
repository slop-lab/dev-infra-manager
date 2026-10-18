# Future VM runtime design

VM-backed development is an open design direction, not a supported backend or
reserved state contract. Backed-up issues #24, #34 and #37 cover VM lifecycle,
resources and isolation. The base runtime interface must accommodate this work
without coupling it to managed Git, a workflow format or SSH transport.

A future adapter should own persistent instance and disk identities, readiness,
command transport, start/stop, keep-data recreation, resource changes and exact
owned cleanup. Guest code must never become a trusted host lifecycle hook.
Neither a VM name nor a previous record alone authorizes adoption of a disk,
network or instance. Failed creation and uncertain cleanup need explicit state
and diagnostic evidence.

Evaluate one provider against real disposable-host behavior before specifying a
profile. Verify nested containers, persistence, host restart, resource read-back
and rollback, missing data, foreign resource refusal and cleanup interruption.
Resource limits and disk quotas must describe observed enforcement. A QEMU CI
guest does not demonstrate a usable persistent development VM.

Host-side Git/review services and secret-bearing applications remain outside
the guest. Backend-neutral user-data export can be designed separately from
runtime identity; importing old grants, sockets or approval state is not a data
transfer mechanism. Unsupported backends must fail clearly rather than fall
back to a different provider.
