# Status

## Current Status

The project is in architecture and planning.

Documented decisions:

- The repository name is `dev-infra-manager`.
- This infrastructure repository is organized as a monorepo.
- Agent workspace containers are untrusted.
- Secret-bearing containers are separate from agent workspace containers.
- Raw secrets are never injected into agent workspace containers.
- Agents can receive approved environment variables and Git configuration for job execution.
- Agents can create nested containers through Sysbox.
- Agent workspaces are ephemeral per job.
- Resource limits apply at the agent workspace boundary.
- Disk quota uses a per-job loopback filesystem for the MVP.
- The managed Git host uses bare Git repositories with a custom pull request layer.
- The managed Git host may run on the same machine or a separate machine.
- Secret-bearing containers are deployed by a controller from approved refs.
- The controller is part of the trusted boundary.
- The MVP assumes KVM is available.

## Future Work

- Define the monorepo directory layout.
- Prototype per-job loopback filesystem creation and teardown.
- Define the Sysbox agent workspace profile.
- Define resource profile configuration.
- Define the managed Git host adapter.
- Define the controller build and deployment flow for approved refs.
- Plan support for non-KVM and nested environments.
- Evaluate rootless operation after the MVP boundary is working.
