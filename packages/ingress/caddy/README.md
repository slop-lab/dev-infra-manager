# DIM Caddy External URL Ingress

Generates a pinned Caddy image build, Caddyfile, and Compose deployment for a
DIM HTTPS ingress using Cloudflare DNS-01 validation. The complete example
pairs it with a plain HTTP ingress on port 8080 because the generated Caddy
deployment owns ports 80 and 443:

[`examples/external-urls/host/cloudflare-caddy`](../../../examples/external-urls/host/cloudflare-caddy)
