# Overview

## Goal

`dev-infra-manager` provides infrastructure for running AI agents in isolated, ephemeral development workspaces while protecting secrets from agents that may attempt to exfiltrate API keys or otherwise misuse their execution privileges.

The infrastructure separates agent-controlled execution from secret-bearing execution. Agents may run commands, read and write files inside their workspace, create nested containers, and push proposed changes to a managed Git host. They must not receive raw secrets, control secret-bearing containers directly, or modify secret-bearing runtime environments without human review.

## Scope

This repository owns the container and infrastructure boundary for agent jobs.

In scope:

- Agent workspace containers.
- Secret-bearing containers.
- Controller-managed deployment of secret-bearing containers.
- Managed Git hosting primitives used by agents to propose changes.
- Backend-selectable container isolation, with Sysbox as the default production backend.
- Resource limits for agent workspaces and nested workloads.
- Ephemeral read-write workspaces for agent jobs.
- Injection of non-secret and approved per-job configuration into agent containers.
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

- Agent workspace containers are untrusted.
- Nested containers created by agents are untrusted.
- Secret-bearing containers are trusted only when built and deployed from reviewed sources.
- Code that can directly or indirectly affect access to secrets is secret-bearing from a review perspective.
- Shared infrastructure maintained by this repository is trusted by default across projects.
