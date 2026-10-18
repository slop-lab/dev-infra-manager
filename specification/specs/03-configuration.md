# Configuration ownership

Client host contexts contain local/SSH selection and launcher settings. The
selected host owns source paths, workspace state, runtime access and optional
service credentials. A remote command does not reinterpret a host path on the
client or forward the client's environment as implicit configuration.

Base workspace state defaults to `$HOME/.local/state/dim`; `DIM_STATE_ROOT`
selects an explicit root. The host validates complete records before resource
access. Base configuration needs neither a backend-selection file nor a
controller, native Git role, workflow or CI service. `DIM_WORKSPACE_IMAGE` and
explicit command flags select the workspace image and resource bounds.

Managed Project/service state defaults to `$HOME/.local/state/dim/managed`;
`DIM_MANAGED_STATE_ROOT` overrides it. Managed source attachments refer to the
core workspace UUID and store only host-side broker/connection configuration.
They do not create another workspace lifecycle or select another agent image.

Optional control-plane preparation writes private service and role files from
reviewed image digests. Connecting validates the serving generation before
recording reusable host connections. Explicit connection environment variables
remain overrides. Private role files have owner-only permissions, cannot be
symlink aliases, and bind credentials to their service and role. Importer,
reviewer, promoter, workspace issuer and execution roles remain distinct.

Native Git owns repository storage and protected-ref policy. Service-owned bare
repositories use numeric Git sharing mode `0600`; startup rejects unsafe state
rather than widening permissions. Candidate-controlled configuration cannot
select host paths, devices, credentials or privileged runtime arguments.

Optional execution has one operator-owned capacity and execution model. A
workflow plugin compiles candidate configuration into normalized plans; trusted
profiles choose images, resource bounds and backend. Mirrors are optional:
ordinary direct access works without a provider, while an explicitly selected
provider must reconcile successfully. KVM execution requires real KVM and never
silently falls back to another execution kind.

Internal storage formats may change together with code. DIM does not silently
adopt old state or erase existing data. Export user data before replacing an
incompatible installation. The installer facade's separate transactional
installation and recovery behavior remains supported.
