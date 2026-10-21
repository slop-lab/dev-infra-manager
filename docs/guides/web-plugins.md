# Web feature plugins

The console keeps login, sessions, origin checks, host workspace operations and
navigation in `@slop-lab/dim-web`. Optional features own their server connection,
validated operations and browser panel in separate Web plugin packages. Shared
operation declarations live in `@slop-lab/dim-contracts-operations`; feature
clients can reuse their input, output and access contracts across CLI and Web.
The feature clients are `@slop-lab/dim-llm-router-client` and
`@slop-lab/dim-execution-client`; neither starts its authoritative service.

A Web plugin is installed on the trusted Web server, not in a repository or
workspace. Installing a host or control-plane service does not automatically
execute its browser code. Operators choose reviewed matching package versions
and explicitly select them in the private Web configuration:

```json
{
  "plugins": [
    {
      "package": "@slop-lab/dim-web-plugin-llm-router",
      "config": { "connectionFile": "/absolute/operator/llm.json" }
    },
    { "package": "@slop-lab/dim-web-plugin-execution" },
    { "package": "@slop-lab/dim-web-plugin-native-git" }
  ]
}
```

This is a fragment of the full Web configuration, which retains its listener,
accounts, session settings and any host operations. A plugin selection without
`config` appears as an available feature with connection instructions. It does
not contact a service. Browser users cannot select server credential paths.
Configuration and operator connection files must be owned regular mode-0600
files. Keep their credentials on the Web server.

A feature-only console can be initialized from this private selection file with:

```sh
dim-web init-features /absolute/features.json --output /absolute/web.json --roles read,operator
dim-web serve /absolute/web.json
```

The selection file may include `pluginHome` to name the installed package runtime
and `operations` to include trusted host settings. Browser roles are explicit;
choose reviewer authority separately when needed. Initialization verifies
configured feature connections before writing a fresh account. At service
startup, an unavailable backend disables its feature while other features remain
usable. Reconnect retries the same server configuration and attests it again;
it cannot change connection paths or grant account authority.
Reconnect is also available for an active feature after service replacement.
Mounted forms retain drafts; refresh the feature's data after reconnecting.

`install-local` installs the three Web plugins and their matching dependency
closure in the separate `DIM_DATA_HOME/web/runtime` runtime. It adds missing
selections while preserving accounts and all existing plugin configuration.
Only a newly added LLM router selection discovers the conventional private
`XDG_CONFIG_HOME/dim/llm/operator.json` connection automatically. Other
connections require explicit project and authority choices. The LLM router CLI
plugin remains an explicit installation; installing the Web console does not
enable it on a host.
When a private `llm/operator-service.json` has been retained, source installation
also restores its isolated operator runtime and owned user service before
starting the console. It preserves router credentials and ledger data. A fresh
installation without that optional configuration does not create a router.

The execution plugin config accepts an absolute `queryConnection` path and an
optional `operatorConnection`. Query-only connections expose job lists and
results; cancellation, retry and worker capacity require the operator connection
and an operator browser role. The Native Git plugin config requires `reviewerConnection`, `projectId` and
`repositoryIds`; `promoterConnection` enables protected promotion and
`syncConnection` enables upstream fetch, merge proposals and publishing. Each
connection is a private absolute file path. See the
[LLM router](../../packages/web/plugins/llm-router/README.md),
[execution](../../packages/web/plugins/execution/README.md) and
[Native Git](../../packages/web/plugins/native-git/README.md) package guides for
complete feature configuration.

Plugins export `webPlugin` using `@slop-lab/dim-web/plugin-api`. Their declaration
provides a unique ID, title, bounded asset map, browser entry and operation
contracts. `create(config)` supplies server-side operation handlers. Each
operation declares read, operator or reviewer access plus input and result
validation. The console checks session roles and CSRF before invoking an
operation. A handler still authenticates to its authoritative service, which
retains its own policy and concurrency checks.

The browser entry exports `mount(container, context)`, optionally returning a
cleanup function. `context.operations` lists the currently permitted operation
names, descriptions and access roles; `context.invoke(name, input)` uses the
authenticated transport and validated server operation. `context.isCurrent()`
guards asynchronous rendering after sign-out or session replacement. Reconnect
updates the existing operations array, so check availability when dispatching.
Keep credentials and connection selection server-side, render results as text,
and dispose listeners or polling when the console calls the cleanup function.
Panels must distinguish a confirmed mutation from a failed subsequent refresh
and preserve unsaved inputs when data or connections are refreshed.

The browser receives feature descriptions, allowed operations and sanitized
results, never raw connection files. Feature panels own their interactions and
presentation; the shared operation contract does not generate a universal form
or turn CLI arguments into a Web API.
