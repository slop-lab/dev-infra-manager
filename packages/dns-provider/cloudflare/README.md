# DIM DNS Provider: Cloudflare

Idempotently creates, updates, verifies, and removes the wildcard DNS record
used by a DIM external URL ingress. Authentication uses a zone-scoped API
token referenced by environment-variable name in DIM configuration.

The provider's opaque argument contains only connection settings:
`{"credentialEnv":"CF_API_TOKEN"}`. It may be omitted to use that default.
Zone and record policy belong to each ingress rather than this reusable
provider instance.

Tests may redirect requests to a local compatible endpoint with
`DIM_CLOUDFLARE_API_BASE`. Production deployments should leave that variable
unset so requests use Cloudflare's public v4 API.
