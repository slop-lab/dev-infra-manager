# `@slop-lab/dim-contracts-external-url`

Shared TypeScript contracts for DIM External URL configuration and DNS-provider
extensions. Install this package when implementing a DNS provider or when a
trusted tool must read and validate DIM's External URL configuration. End users
normally install
[`@slop-lab/dim-plugin-external-urls`](https://www.npmjs.com/package/@slop-lab/dim-plugin-external-urls)
instead.

## Installation

Pin the same reviewed DIM release as the controller and plugin:

```bash
npm install --save-exact '@slop-lab/dim-contracts-external-url@0.8.0'
```

The package is ESM-only, requires Node.js 24 or 26, and includes TypeScript
declarations.

## DNS provider extension

A provider plugin registers an `ExternalUrlDnsProviderDriver` under
`EXTERNAL_URL_DNS_PROVIDER_EXTENSION`. The driver:

- validates and normalizes its opaque provider and DNS-record arguments;
- creates, verifies, and removes one wildcard record for an ingress;
- describes any Caddy DNS-01 modules, directive, and environment it requires.

```ts
import {
  DIM_PLUGIN_API_VERSION,
  type DimPlugin
} from "@slop-lab/dim-core";
import {
  EXTERNAL_URL_DNS_PROVIDER_EXTENSION,
  type ExternalUrlDnsProviderDriver
} from "@slop-lab/dim-contracts-external-url";

const driver: ExternalUrlDnsProviderDriver = {
  normalizeProviderArgument: (argument) => argument,
  normalizeRecordArgument: (argument) => argument,
  async ensure(operation) { /* reconcile wildcard DNS */ },
  async verify(operation) { /* verify wildcard DNS */ },
  async remove(operation) { /* remove wildcard DNS */ },
  caddyDns01(providerArgument) {
    return {
      modules: ["github.com/example/caddy-dns"],
      directive: "example",
      environment: {}
    };
  }
};

export default {
  name: "@example/dim-plugin-dns",
  apiVersion: DIM_PLUGIN_API_VERSION,
  register(host) {
    host.registerExtension(
      EXTERNAL_URL_DNS_PROVIDER_EXTENSION,
      "example",
      driver
    );
  }
} satisfies DimPlugin;
```

Provider implementations must keep credentials in the provider argument and
must not place them in record arguments or returned public state. DIM stores
the configuration file with mode `0600` and omits provider arguments from list
responses.

## Configuration helpers

The package exports `emptyExternalUrlConfig`, `validateExternalUrlConfig`,
`readExternalUrlConfig`, `writeExternalUrlConfig`, and
`externalUrlConfigPath`. The default path is:

```text
${XDG_CONFIG_HOME:-$HOME/.config}/dim/external-urls.json
```

`DIM_EXTERNAL_URL_CONFIG` overrides it. The persisted schema is version 1 and
contains named `dnsProviders` and `ingresses`; driver-specific arguments remain
opaque strings.

This is a pre-stable extension contract and may change between minor `0.x`
releases. See the
[External URLs documentation](https://github.com/slop-lab/dev-infra-manager/blob/main/docs/external-urls.md)
and [source repository](https://github.com/slop-lab/dev-infra-manager).
