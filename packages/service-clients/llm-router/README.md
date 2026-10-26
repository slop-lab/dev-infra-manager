# LLM router operator client

`@slop-lab/dim-service-client-llm-router` is a shared caller-side library, consumed
by host plugins, Web plugins or trusted services. It does not register a plugin
or deploy the remote service.

This package owns bounded operator HTTP calls and private connection-file access. Shared operation definitions and wire schemas belong to `@slop-lab/dim-contracts-llm-router`. It has no router database or provider dependency. CLI and Web plugins call the same definitions, and the service validates both directions with them.

Create a private, owned mode-0600 connection file with absolute paths:

```json
{"schemaVersion":1,"endpoint":"http://127.0.0.1:8318","actorId":"operator","keyFile":"/absolute/operator.key"}
```

The key file must also be mode 0600 and contain a separately generated 32-byte base64url secret. Endpoints are exact HTTPS origins or explicit HTTP IP origins; requests never follow redirects. `createLlmRouterClient(path).invoke(name,input)` validates input/output, bounds response bytes and applies a deadline. Errors never include server response bodies or credentials.

An explicit HTTP 4xx response is a known service rejection. A fetch failure,
HTTP 5xx response, or missing, truncated, oversized, malformed or schema-invalid
success response throws `LlmRouterResultUnavailableError`: the request may have
reached the service, so mutation callers must read authoritative state before
retrying.
Known HTTP 4xx responses throw `LlmRouterRejectedError` with a bounded status and
fixed public error code, not a raw service body. The LLM-owned controller envelope
retains that distinction across a host console invocation.

`capabilities`, `overview`, `health`, `projects`, `project.policy`, `usage`, `principals`, and `requests` require read access. Mutation operations require operator access. Prompt/response captures, credential paths, raw keys and token hashes are intentionally absent.

`client.capabilities()` queries the service for operations allowed to the authenticated actor. Presenters intersect this result with their own session roles, so a read-only router connection never advertises mutation controls. The service still rechecks permission on every invocation.

Account operations keep credentials independent of routes. `accounts` returns only account ID, reference, provider and connection state. Operator-only `account.create` takes a Codex partition or a compatible API endpoint/key; API keys are write-only. Account ID and label are optional at enrollment: the service generates a unique internal ID and a provider label. After Codex login, an unchanged default label displays the saved provider email when available. `account.rename` updates a managed account label without changing its ID, credentials, route bindings or usage attribution; static configuration accounts are edited in their configuration. `account.login.start` and `account.login.status` expose a bounded Codex device authorization session. `route.upsert` binds explicit models to a selected account. No account is selected automatically from usage and no provider credential is returned to Web or workspace clients.
