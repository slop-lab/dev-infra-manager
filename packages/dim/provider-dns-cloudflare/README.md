# DIM Cloudflare DNS Provider

Idempotently creates, updates, verifies, and removes the wildcard DNS record
used by a DIM external URL ingress. Authentication uses a zone-scoped API
token referenced by environment-variable name in DIM configuration.

Tests may redirect requests to a local compatible endpoint with
`DIM_CLOUDFLARE_API_BASE`. Production deployments should leave that variable
unset so requests use Cloudflare's public v4 API.
