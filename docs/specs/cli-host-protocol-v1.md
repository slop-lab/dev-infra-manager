# CLI–host protocol, version 1

This is a retained compatibility boundary, independent of DIM package release
versions. A CLI and its selected host must share a wire version. They do not
need the same CLI, core, installer, plugin or contract-package release. Other
connections, such as worker–scheduler and host–control-plane service APIs, own
their own compatibility requirements.

## Endpoint and negotiation

The host executable is `dim-host`. A local caller invokes
`dim-host __host ENCODED`; an SSH caller invokes `dim __host ENCODED` through the
installer facade, with the existing fixed mise bootstrap when needed. The
facade routes this reserved entrypoint to its host runtime even when no CLI is
installed. Executables and connection configuration are operator-controlled;
repositories cannot select an endpoint executable.

`ENCODED` is base64url-encoded UTF-8 JSON, passed as one argument without shell
interpolation. The envelope is:

```json
{"protocol":"dim.cli-host","version":1,"operation":"capabilities","input":{}}
```

The host replies with one JSON value on stdout:

```json
{"protocol":"dim.cli-host","versions":[1]}
```

The client negotiates before running a command or starting a forward. It requires
version 1 in the returned set; it must not compare package release versions.
No common version means an error before command execution. Hosts must retain
the v1 capability inquiry if they advertise newer command versions, so old
clients can discover incompatibility. Both CLI and host executables also expose
this same capability record through `--host-protocol` for staged installation
checks without running application commands.

Unknown protocol identifiers, unsupported versions, malformed operation inputs
and unknown envelope keys are rejected before loading feature command code.
Protocol errors use exit status 2 and a diagnostic on stderr. Diagnostic wording
is not a machine-readable contract. Command errors are their own opaque output
and exit status; they do not change this wire contract.

## Fixed operations

| Operation | Input | Output |
| --- | --- | --- |
| `capabilities` | `{}` | Capability record above |
| `command` | `{args: string[], terminal?: boolean}` | Host-owned stdout, stderr and exit status |
| `workspace.endpoint` | `{name: string}` | `{workspaceId: string, runtimeStatus: "running" \| "stopped" \| "missing" \| "unknown"}` |
| `workspace.connect` | `{name: string, port: integer, workspaceId: string}` | Bidirectional binary stdin/stdout, stderr diagnostics and exit status |

Arguments preserve order, empty strings and literal characters; no argument is
evaluated as shell code. NUL characters are invalid. `port` is between 1 and
65535. Names and identities are nonempty strings. Stdout is reserved for the
declared result or stream; diagnostics use stderr. No daemon starts merely to
answer capabilities.

The client reserves its own `host` connection-management commands, loopback
`forward` and `workspace forward`, `--host`, bare client `--version`, and
`--host-protocol`. Other commands, options and help are interpreted on the host.
New host commands and flags require no client parser update. Domain JSON printed
by commands is opaque to the CLI and is not frozen by this protocol.

`terminal` is a presentation hint, not permission to install host code or approve
a review. Interactive host actions still require their actual TTY and existing
authorization/confirmation. Terminal sessions may use a PTY; capability/endpoint
records and binary forwarding never do. Interrupt, termination and hangup are
forwarded to the child session. Cancellation must close owned forwarding
connections and listeners, without deleting workspaces or continuing a command
silently.

For a forward, the client resolves a running workspace once and pins every
connection to the returned `workspaceId`. A replacement with the same name must
not inherit that forward. The host still verifies identity and port access;
the client does not receive a host token or a complete workspace record.

## Evolution and installation

Keep the v1 request fields and their meanings unchanged. Extending feature
commands, domain output or plugin APIs does not require a new wire version.
Changes to these four operations require a new version and explicit negotiation;
do not quietly reinterpret v1. Compatible response additions may be ignored by
old clients. Keep frozen v1 fixtures independent of the current codec so changing
both implementations cannot conceal a compatibility break.

CLI and host runtime install into independent prefixes. Updating host core or
its plugins must preserve an already installed compatible CLI. Explicit CLI
installation updates only the client. A staged incompatible host must be rejected
before replacing the active runtime. Host plugin and service dependency pinning
remains separate from this CLI compatibility rule.

This deliberately creates no permanent compatibility promises for internal
workspace request objects, database models, command-specific JSON, or other
public package exports.
