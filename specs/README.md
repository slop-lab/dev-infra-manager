# Specification Index

This directory contains normative specifications for `dev-infra-manager`.
The goal is to make implementation work possible from the written contract, without depending on unstated behavior in the current code.

## Reading Order

Read the specifications in this order when making broad changes:

1. [System Goals](00-system-goals.md)
2. [Threat Model](01-threat-model.md)
3. [Trust Boundaries](02-boundaries-and-trust.md)
4. [Configuration](03-configuration.md)
5. Feature specifications for the area being changed.
6. Local implementation details only when changing code close to a specific file format, command shape, or image entrypoint.

## Specification Levels

### Global Specifications

Global specifications define security, trust, compatibility, and architecture invariants.
Changes to global specifications can affect multiple modules and require careful review.

Global specifications:

- [System Goals](00-system-goals.md)
- [Threat Model](01-threat-model.md)
- [Trust Boundaries](02-boundaries-and-trust.md)
- [Configuration](03-configuration.md)

### Feature Specifications

Feature specifications define externally observable behavior for one subsystem.
They describe inputs, persistent state, operations, invariants, failure behavior, and verification.

Feature specifications:

- [Job Lifecycle](04-job-lifecycle.md)
- [Runtime Backends](05-runtime-backends.md)
- [Storage Backends](06-storage-backends.md)
- [Managed Git Host](07-managed-git-host.md)
- [Secret Runtime Deployment](08-secret-runtime-deploy.md)
- [Controller](09-controller.md)
- [CLI Contract](10-cli-contract.md)
- [Doctor Checks](11-doctor-checks.md)
- [Verification](12-verification.md)

### Local Details

Local implementation details document formats and command shapes that are important for compatibility but are not system-wide policy by themselves.
Changing these details should still preserve the global and feature specifications.

Local details:

- [Docker Command Shapes](local-details/docker-command-shapes.md)
- [Filesystem Layout](local-details/filesystem-layout.md)
- [Managed Git Hook Format](local-details/hook-format.md)
- [Image Entrypoints](local-details/image-entrypoints.md)
- [Installation Scripts](local-details/installation-scripts.md)

## Normative Language

- `must`: required behavior.
- `must not`: prohibited behavior.
- `should`: recommended behavior that can be changed only with a documented reason.
- `may`: allowed behavior.

If a specification conflicts with current code, treat the conflict as a defect in either the spec or implementation and resolve it explicitly.
