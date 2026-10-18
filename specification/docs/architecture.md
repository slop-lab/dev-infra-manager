# Architecture

The base product is a Git-backed development workspace. Managed Git, review and
CI are optional integrations. A base installation has no native service, workflow
parser, controller-proxy or QEMU package dependency.

```text
CLI presentation + host context
    -> local process or authenticated SSH stdio
        -> host application
            -> workspace lifecycle service
                -> workspace store
                -> Git source acquisition
                -> container runtime

CLI -- selected managed operation --> optional dim-managed/cli
    -> managed Git / review / CI / controller integrations
        -> shared core process, storage and locking primitives

installer facade --> exact base packages
                 --> explicitly selected managed component/plugins
```

The selected host owns state, filesystem paths, Git acquisition and runtime
operations. The client never treats a remote source path as a local path and
never exposes a public administration port. Commands carry structured payloads;
SSH shell input contains fixed launcher code and base64url data.

`WorkspaceService` owns the lifecycle. `WorkspaceStore` parses complete records
at the storage boundary and serializes mutations by workspace. Source acquisition
creates an independent committed checkout without host object-store sharing.
`ContainerWorkspaceRuntime` owns its labeled container, network and persistent
home/checkout/Docker volumes. Runtime observation is returned separately from
persisted lifecycle state, so a stopped or unavailable Docker daemon does not
rewrite user intent or recovery evidence.

The base workspace is one unprivileged Sysbox container. It receives no host
Docker socket, host checkout bind or native role credential. Source is seeded
once through a stream. Recreation preserves existing storage and rejects missing
or foreign storage; it never interprets missing user data as a new empty checkout.
Docker resource changes report whether replacement was needed. Process capture,
streaming and PTY execution share process-group cancellation ownership.

The base image owns only development/runtime tools and its entrypoint. The
optional managed integration owns trusted outer lifecycle infrastructure, Git
relays/proxies, QEMU assets and its own image namespace. Base and managed state,
runtime sockets and default image tags are separate.

The optional native Git service owns registered repository identity, protected
refs, proposal namespaces, immutable review tuples, human approval and checked
promotion. Optional execution services report candidate-bound evidence; execution
results do not grant approval or promotion authority. Existing ordinary/root-CI/
QEMU state models and workflow parsing are still being consolidated. Their
presence in `dim-managed` is an isolation step, not the finished execution design.

The installer facade retains installation, exact package selection, promotion,
activation and recovery. It does not start an optional controller on a fresh
base installation. An existing selected controller is restarted with rollback on
failure. Local package bundles select component dependency closures rather than
installing every optional tarball.

See the [rework plan](architecture-rework-plan.md) for the remaining ownership
changes, user journeys, exported issues and capable-host verification. Contracts
for a managed feature apply when that feature is selected; they do not make it a
prerequisite for ordinary remote development.
