# DIM DNS Provider Plugin: Cloudflare

Idempotently creates, updates, verifies, and removes the wildcard DNS record
used by a DIM external URL ingress. Authentication uses a zone-scoped API
token stored in DIM configuration.

The provider's opaque argument contains the actual credential:
`{"credential":"..."}`. DIM stores it in its mode-`0600` External URL config
and does not expose provider arguments through the list API. Zone and record
policy belong to each ingress's opaque `dnsArgument` rather than this reusable
provider instance.

Install this package together with the External URLs plugin. It registers the
`cloudflare` driver through DIM's named extension registry; the External URLs
plugin has no package dependency on this implementation.

Tests may redirect requests to a local compatible endpoint with
`DIM_CLOUDFLARE_API_BASE`. Production deployments should leave that variable
unset so requests use Cloudflare's public v4 API.
