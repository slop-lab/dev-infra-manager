# `@slop-lab/dim-plugin-dns-cloudflare`

Cloudflare DNS provider for DIM's External URLs plugin. It idempotently
creates, verifies, updates, and removes the wildcard DNS record used by a
managed HTTPS ingress.

## Installation

Install the provider and External URLs plugin at the same exact DIM version:

```bash
npx '@slop-lab/dim-installer@0.6.0' install-plugin \
  '@slop-lab/dim-plugin-external-urls@0.6.0' \
  '@slop-lab/dim-plugin-dns-cloudflare@0.6.0'
```

Restart the managed DIM controller after changing installed plugins. Confirm
discovery with:

```bash
dim plugin list
```

## Configure Cloudflare

Create a Cloudflare API token scoped to DNS editing and zone reading for the
intended zone. Store it as a named reusable provider:

```bash
dim external-url dns-provider add cloudflare \
  --name cloudflare-main \
  --argument '{"credential":"REPLACE_WITH_API_TOKEN"}'
```

The credential is stored in DIM's mode-`0600` External URL configuration and
is omitted from list output. Do not commit this command with a real token to a
repository or pass it through an untrusted agent environment.

The Caddy ingress owns zone and record policy:

```json
{"zone":"example.com","value":"203.0.113.10","proxied":false}
```

- `zone` is the Cloudflare zone containing the wildcard record.
- `value` determines the record type: IPv4 becomes `A`, IPv6 becomes `AAAA`,
  and any other value becomes `CNAME`.
- `proxied` defaults to `false`.

The External URLs plugin combines this record argument with its Caddy ingress
settings and manages `*.<ingress-domain>`.

## Runtime behavior

The plugin registers the `cloudflare` driver through DIM's named extension
registry; the External URLs plugin does not import this package directly.
Provider and External URL plugin versions should therefore still match the DIM
controller release.

`DIM_CLOUDFLARE_API_BASE` exists only for tests against a compatible local
endpoint. Leave it unset in normal use so the plugin calls Cloudflare's public
v4 API.

See the complete
[Cloudflare and Caddy setup](https://github.com/slop-lab/dev-infra-manager/blob/main/docs/external-urls.md#http-and-https-with-cloudflare-dns-and-caddy)
and the [source repository](https://github.com/slop-lab/dev-infra-manager).
