# Overview

## Goal

`dev-infra-manager` provides infrastructure for running AI agents in isolated, ephemeral development workspaces while protecting secrets from agents that may attempt to exfiltrate API keys or otherwise misuse their execution privileges.

The infrastructure separates agent-controlled execution from secret-bearing
execution inside each workspace root. Agents run in a child container with
their own nested runtime. A trusted root-level controller may run
secret-bearing sibling containers, but agents must not receive their raw
secrets, access the controller runtime, or control those siblings directly.

## Scope

This repository owns the container and infrastructure boundary for agent workspaces.

In scope:

- Workspace-root controller containers and nested agent containers.
- Secret-bearing containers.
- Controller-managed deployment of secret-bearing containers.
- Managed Git hosting primitives used by agents to propose changes.
- Backend-selectable container isolation, with Sysbox as the default production backend.
- Resource limits for agent workspaces and nested workloads.
- Persistent read-write project workspaces.
- Injection of non-secret and approved workspace configuration.
- Support for adding project Git repositories later.

Out of scope:

- The agent runtime process itself.
- Agent reasoning, tool orchestration, and MCP tool implementation.
- Internet access policy for the agent runtime.
- Human collaboration UI.
- GitHub synchronization.
- Agent command audit logs.
- Model request audit logs.
- Project-specific product code.

## Threat Model

The primary threat is an AI agent that attempts to obtain secrets or alter trusted execution paths. The agent may execute arbitrary commands within its assigned workspace and may create nested containers, but it is not trusted with secret material.

The infrastructure assumes:

- Agent containers are untrusted.
- Nested containers created by agents are untrusted.
- Secret-bearing containers are trusted only when built and deployed from reviewed sources.
- Code that can directly or indirectly affect access to secrets is secret-bearing from a review perspective.
- Shared infrastructure from this repository is trusted only after a project directly reviews the complete pinned DIM revision.
