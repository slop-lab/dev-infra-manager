# Cloudflare DNS + HTTP and Caddy HTTPS ingresses

This example serves the same wildcard domain over two named ingresses:

```text
http://WORKSPACE--NAME.remote.example.com:8080
https://WORKSPACE--NAME.remote.example.com
```

Plain HTTP uses DIM's built-in router on port 8080. Caddy owns ports 80 and
443, redirects its port 80 traffic to HTTPS, terminates TLS on 443, and
forwards to the loopback-only HTTPS ingress router.

Configure the Cloudflare provider and both ingresses:

```bash
dim external-url add-provider cloudflare cloudflare-main \
  --zone example.com \
  --record-type A \
  --target 203.0.113.10 \
  --credential-env CF_API_TOKEN

dim external-url ingress add builtin-http --name public-http \
  --description "Public HTTP development URL" \
  --scheme http \
  --argument '{"domain":"remote.example.com","publicPort":8080,"listenHost":"0.0.0.0","listenPort":8080}'

dim external-url ingress add caddy --name public-https \
  --description "Public HTTPS development URL" \
  --scheme https \
  --argument '{"domain":"remote.example.com","listenHost":"127.0.0.1","listenPort":"auto","publicListenHost":"100.64.0.10","provider":"cloudflare-main"}'

CF_API_TOKEN=... dim external-url ingress setup public-https \
  --output .dim/external-url
```

`ingress setup` idempotently reconciles `*.remote.example.com` in Cloudflare and
writes the complete Caddy deployment; this example does not maintain a second
hand-written copy. Copy the generated `.env.example` to `.env`, supply the
same zone-scoped token, and start it:

```bash
cd .dim/external-url/public-https
cp .env.example .env
docker compose up --detach --build
dim external-url ingress verify public-https
```

The credential must be a Cloudflare API Token accepted as a Bearer token, not
a Global API Key. Restrict it to the configured zone with `Zone.Zone:Read`
and `Zone.DNS:Edit`. Caddy uses it for ACME DNS-01 issuance and renewal.

From a workspace with DIM CLI available, issue both URL forms for one target.
The workspace identity and URL names are inferred:

```bash
dim external-url request --ingress public-http --container dev --port 3000
dim external-url request --ingress public-https --container dev --port 3000
```

The host must accept TCP 8080, TCP 80, TCP 443, and optionally UDP 443 for
HTTP/3. Plain HTTP cannot also use host port 80 with this generated deployment
because Caddy owns it for HTTP-to-HTTPS redirects.
