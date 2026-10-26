# Changelog

## 0.10.0 — Unreleased

- Attach persistent workspaces to independently operated LLM routing through a host-owned gateway with local-only guest credentials, immutable workspace fencing and active-stream cancellation. OpenCode and OMO adapters select the reviewed route while provider keys and scoped issuer credentials remain outside the guest.
  Share guest file preparation with other host integrations, repair attached
  workspace helpers on readiness and advertise connection state to guest agents
  without rotating credentials or requiring repository metadata.
  Generate provider timeouts accepted by pinned OpenCode, preserving explicit
  user deadlines and model selections so configuration loading does not reject
  the attached route.
