# Overview

## Goal

`dev-infra-manager` is a self-hosted execution and trust layer for coding-agent
development. It combines persistent development workspaces with separate
verification and a reviewed promotion path into protected refs and trusted
operations.

DIM does not choose or schedule agent work. Interactive agents and external
orchestrators own that control-plane policy; DIM owns the execution,
repository, verification, and trust boundaries in which they operate.

The infrastructure separates agent-controlled execution from secret-bearing
interfaces. Projects may run an agent as a nested service with its own private
Docker daemon, but core does not own that service. Agents must not receive raw
secrets or either Docker control socket. The current privileged workspace does
not make sibling Project services a strong isolation boundary; reviewed
Project code and constrained service interfaces remain required.

## Scope

This repository owns the container and infrastructure boundary for agent workspaces.

In scope:

- Trusted workspace containers and Project-owned agent containers.
- Secret-bearing containers.
- Controller-managed deployment of secret-bearing containers.
- Managed Git hosting primitives used by agents to propose changes.
- Backend-selectable container isolation, with Sysbox as the default
  nested-container backend.
- Project-scoped CI runners that verify separate checkouts outside workspace
  state.
- Resource limits for agent workspaces and nested workloads.
- Persistent read-write project workspaces.
- Injection of non-secret and approved workspace configuration.
- Project-scoped repository sets and explicit synchronization with external
  Git repositories.

Out of scope:

- The agent runtime process itself.
- Agent reasoning, tool orchestration, and MCP tool implementation.
- Internet access policy for the agent runtime.
- Human collaboration UI.
- Automatic provider-specific GitHub synchronization.
- Agent command audit logs.
- Model request audit logs.
- Project-specific product code.
- Task selection, issue-tracker integration, scheduling, and retry policy.

## Threat Model

The primary threat is an AI agent that attempts to obtain secrets or alter trusted execution paths. The agent may execute arbitrary commands within its assigned workspace and may create nested containers, but it is not trusted with secret material.

The infrastructure assumes:

- Agent containers are untrusted.
- Nested containers created by agents are untrusted.
- Secret-bearing containers are trusted only when built and deployed from reviewed sources.
- Code that can directly or indirectly affect access to secrets is secret-bearing from a review perspective.
- Shared infrastructure from this repository is trusted only after a project directly reviews the complete pinned DIM revision.
