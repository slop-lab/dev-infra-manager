# Specification Index

This directory records requirements, externally observable contracts, current
implementation profiles, and their verification for `dev-infra-manager`.
The goal is to make implementation work possible from written decisions,
without treating every current implementation detail as permanent product
policy.

## Reading Order

Read the specifications in this order when making broad changes:

1. [System Goals](00-system-goals.md)
2. [Threat Model](01-threat-model.md)
3. [Trust Boundaries](02-boundaries-and-trust.md)
4. [Configuration](03-configuration.md)
5. Feature specifications for the area being changed.
6. Local implementation details only when changing code close to a specific file format, command shape, or image entrypoint.

## Document Kinds

Every new specification should declare one of these kinds below its title.
Existing documents are classified in the index until their headers are
updated.

- **Intent** — product goals, non-goals, threat assumptions, and security
  invariants. It explains why lower-level contracts exist.
- **Contract** — independently normative, externally observable behavior or a
  boundary that implementations must preserve.
- **Implementation profile** — the currently selected mechanism, format,
  command shape, or image behavior. It is normative for compatibility only
  where an identified Contract requires it.
- **Verification** — evidence required for named Intent or Contract
  requirements. A test is not itself a security boundary.
- **Decision record** — rationale and trade-offs for a chosen design, with an
  accepted, superseded, or proposed status.

Documents may currently be mixed. Such a document must label sections whose
kind differs from the document's primary kind; substantial new material should
instead be split.

## Index

| Document | Primary kind | Notes |
| --- | --- | --- |
| [System Goals](00-system-goals.md) | Intent | Product outcomes and global invariants |
| [Threat Model](01-threat-model.md) | Intent | Assumptions, assets, required defenses, residual risk |
| [Trust Boundaries](02-boundaries-and-trust.md) | Contract | Normative isolation and authority boundaries |
| [Configuration](03-configuration.md) | Contract | Mixed with current environment-variable choices |
| [Runtime Backends](05-runtime-backends.md) | Implementation profile | Must preserve the trust and resource contracts |
| [CLI Contract](10-cli-contract.md) | Contract | User-visible commands, output, and failure behavior |
| [Doctor Checks](11-doctor-checks.md) | Verification | Includes some user-visible diagnostic contracts |
| [Verification](12-verification.md) | Verification | Repository-wide gates and evidence |
| [Project, Repository, and Workspace Lifecycle](13-repo-workspace-lifecycle.md) | Contract | Mixed with state paths and runtime wiring |
| [Installer Facade](14-installer-facade.md) | Contract | Mixed with installation implementation choices |
| [Image Entrypoints](local-details/image-entrypoints.md) | Implementation profile | Image-local compatibility details |
| [Installation Scripts](local-details/installation-scripts.md) | Implementation profile | Script and packaging details |

## Requirement Traceability

Normative Intent and Contract requirements should receive stable identifiers
when next edited, for example `BOUNDARY-AGENT-001` or `CLI-REPO-URL-001`.
Implementation profiles and verification sections should reference those IDs
instead of restating the requirement.

For a cross-cutting change, the review description should show:

```text
Intent requirement
  -> Contract requirement
    -> implementation profile or decision record
      -> verification evidence
```

Not every link is required. A security invariant may have several independent
tests, while a refactor may change an implementation profile without changing
Intent or Contract. Accepted design rationale belongs in `specs/decisions/`
and should state which requirements it serves and what would supersede it.

## Normative Language

- `must`: required behavior.
- `must not`: prohibited behavior.
- `should`: recommended behavior that can be changed only with a documented reason.
- `may`: allowed behavior.

Normative terms apply to Intent and Contract requirements. In implementation
profiles they describe the current supported implementation, not an
independent product invariant, unless a Contract ID is cited.

If a specification conflicts with current code, treat the conflict as a defect
in either the spec or implementation and resolve it explicitly.
