# DIM development repository

This root monorepo is the complete source candidate. Production packages,
plugins, centralized tests, verification, examples, specifications and workflows
come from the same commit and tree. Do not assemble a candidate from component
heads or sibling repositories.

Use [the source workflow](usage.md#install-development-sources) to build and
install matching local artifacts. Use [the architecture plan](architecture-rework-plan.md)
for the current responsibility changes and the backed-up issue backlog.

The repository's forge helpers are contribution tools, separate from the DIM
runtime. Resolve the configured forge through the repository's pull-request
skill before publishing a PR. A passing CI job does not publish source,
approve a protected-ref update or grant registry credentials.

Managed review and protected-ref promotion are optional runtime capabilities.
Public release publication remains a separately authorized maintainer action.
