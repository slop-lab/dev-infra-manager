# Overview

DIM provides persistent isolated development workspaces from ordinary Git
repositories on local or SSH-selected Linux hosts. The host owns identity,
source acquisition, state and runtime resources. The CLI owns presentation and
transport. A workspace owns its development tools, checkout and private nested
Docker daemon.

The base runtime is one unprivileged Sysbox container with persistent checkout,
home and Docker-data volumes. It needs no resident controller or Project
registration. Host controls and operator credentials stay outside the agent.
This is practical development containment, not hostile-tenant security.

Managed Git, reviews, CI, shared services and URL publication are optional
integrations. Their authority and configuration are independent of ordinary
workspace lifecycle. Workflow interpretation belongs to a workflow integration;
a generic runtime must not understand a repository's CI language.

Start with [usage](usage.md), inspect the [responsibility map](architecture.md),
or follow the [rework plan](architecture-rework-plan.md) for remaining changes
and the backed-up issue backlog.
