# Threat Model

## Primary Threat

The primary threat is an AI agent that attempts to obtain secrets, bypass review, alter trusted deployment paths, or use its execution privileges outside the intended workspace.

The agent may:

- Run arbitrary commands inside its assigned workspace container.
- Read and write arbitrary files visible inside that container.
- Create nested containers through the selected runtime backend.
- Push Git refs to managed repositories when credentials or local access allow it.
- Generate source code, Dockerfiles, scripts, and config files.

The agent must not be trusted with raw secrets or direct control of secret-bearing environments.

## Assets

Protected assets:

- AI inference API keys and other raw secrets.
- Secret-bearing container filesystem and runtime configuration.
- Secret-bearing source code before human review.
- Controller code and configuration that can deploy secret-bearing containers.
- Approved Git refs used for trusted deployment.
- Host container runtime control plane.
- Host filesystem outside configured job state and mount roots.

## Attacker Capabilities

The agent is assumed to be capable of:

- Arbitrary command execution inside its workspace.
- Arbitrary file reads and writes inside its workspace.
- Running build tools and package managers.
- Creating nested containers if the backend supports it.
- Attempting network access allowed by the surrounding agent runtime.
- Attempting to push directly to protected Git refs.
- Attempting to modify Dockerfiles or deployment scripts.

## Required Defenses

- Do not inject raw product/runtime secrets into agent environment variables,
  files, volumes, or images. Internal capability credentials explicitly
  granted to the agent, such as an unprotected-branch Git writer, must be
  scoped so disclosure cannot grant protected-ref or runtime-secret access.
- Do not mount the host Docker socket into agent workspace containers.
- Do not mount secret-bearing volumes into agent workspace containers.
- Block direct pushes to protected refs in managed bare repositories.
- Deploy secret-bearing containers only from configured approved refs.
- Treat controller and secret runtime code as trusted-boundary code.
- Keep job workspaces isolated per job ID.
- Enforce CPU, memory, pid, and timeout limits at the outer agent container boundary.
- Enforce aggregate disk quota when using the `loopback` storage backend.

## Out-Of-Scope Threats

These are outside this repository's direct scope:

- Model-level prompt injection handling.
- Network allow/deny policy enforcement by the agent runtime.
- Human reviewer correctness.
- Base image review completeness.
- Kernel or runtime vulnerabilities in Docker, Sysbox, gVisor, Podman, or Linux.
- Physical host compromise.

## Residual Risk

- `directory` storage does not enforce disk quota.
- A vulnerable selected runtime backend can break the intended boundary.
- Secret-bearing code review quality depends on human reviewers and project process.
- The managed PR layer is local and minimal; it is not a full GitHub replacement.
