# DIM External URL Contracts

Shared configuration, validation, and persistence contracts for the DIM
external URL system, ingress integrations, and DNS providers.

DNS provider plugins register an `ExternalUrlDnsProviderDriver` under
`EXTERNAL_URL_DNS_PROVIDER_EXTENSION`. A driver owns provider and per-record
argument normalization, DNS reconciliation, and the Caddy DNS-01 module
description. Consumers select it by its registered driver name and never
import the implementation package.
