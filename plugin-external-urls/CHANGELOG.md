# External URLs changelog

## Unreleased

Target: `0.10.0` internal development candidate.

- Publish optional HTTP, HTTPS and TCP routes for ordinary and native-attached
  core workspaces through owned in-workspace relays. Each new request or flow
  verifies workspace identity and runtime ownership, recovers after container
  recreation, and denies stale routes after discard or IP reuse. Workspace
  grants and provider credentials stay on the trusted host. TCP flows preserve
  independent half-close directions, including delayed binary responses.
