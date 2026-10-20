# `@slop-lab/dim-web`

Optional authenticated operations UI for local or SSH development hosts, shared
CI, and managed Git review. Ordinary Git hosts need no control plane. CI clients
load the optional `@slop-lab/dim-control-plane-admin` package only when CI is configured. Browser accounts
have explicit `read`, `operator`, and `reviewer` roles. Host selectors, executable
paths, service credentials and worker leases remain on the server.

## Ordinary Git hosts

Install the optional package and create a mode-0600 operations settings file:

```json
{
  "hosts": [{
    "id": "devbox",
    "selector": "configured-ssh-host",
    "executable": "/absolute/path/to/dim"
  }],
  "consoles": [{ "name": "Agent console", "url": "https://agents.example.internal/" }]
}
```

`selector` names an existing DIM host configuration belonging to the service
account. `executable` is a trusted installed public DIM CLI. It is executed with
separate allowlisted arguments, without a shell. The browser cannot change it,
choose an SSH address, execute arbitrary commands, or select a state directory.
Console URLs must use HTTPS or loopback HTTP and contain no credentials, query
or fragment. They open separately and retain their own service authentication.

```sh
mise use --raw --global 'npm:@slop-lab/dim-web@0.10.0'
dim-web init-operations /absolute/operations.json --output /absolute/web.json --port 9081
dim-web serve /absolute/web.json
```

Save the generated browser password. Initialization creates a new private
configuration and stores only its scrypt hash. Existing files are never
replaced. Operators can create workspaces from HTTP(S), SSH or Git repository URLs on an explicitly
configured host, with an optional ref, runtime, image and CPU/memory/PID limits.
Empty limits use the host defaults; `unlimited` removes a limit. A VM workspace
requires its provider to be installed and an explicit reviewed image fingerprint.
Creation uses ordinary Git and needs no control plane. The UI lists workspaces
and their observed runtime status, starts,
stops, restarts and recreates them, updates CPU/memory/PID limits, and discards
persistent data after explicit browser confirmation. Actions on existing
workspaces pass the selected
workspace UUID through the public CLI's `--expect-id` guard; the host checks it
inside its workspace lock before changing state. A reused name cannot redirect
an action to a replacement workspace.

## Shared CI and managed Git

After installing the optional control-plane administration package and connecting the control plane,
add these settings to the operations file:

```json
{
  "hosts": [],
  "ci": {
    "queryConnection": "/absolute/SETUP/connections/ci-query.json",
    "operatorConnection": "/absolute/SETUP/connections/ci-operator.json"
  }
}
```

The administration package is an optional peer; install the same exact
`@slop-lab/dim-control-plane-admin` version alongside web when selecting CI. The two connection files
are separate owner-only credentials bound to the connected generation. CI can
be offline while browser configuration is initialized. The UI shows at most 100
recent execution summaries, one execution's bounded stdout/stderr diagnostics,
and configured worker slot occupancy. Occupancy does not assert worker liveness.
Cancellation fences running capacity until owned cleanup; explicit retries use
a stable request UUID and preserve intake uniqueness. Query accounts cannot
mutate executions. There is no browser worker-token or arbitrary HTTP proxy.

Initialize combined operations and review from generated private role files:

```sh
dim-web init SETUP/connections/reviewer.json --project my-project --repository public --repository private \
  --operations /absolute/operations.json \
  --promoter SETUP/connections/promoter.json \
  --output /absolute/web.json --port 9081
```

Both extra flags are optional. The reviewer and optional promoter identities
are attested against the live native Git service and exact generation before
writing configuration. The promoter must have the same endpoint and generation
as the reviewer. Protected promotion retains native Git's human approvals,
current job evidence, freshness and atomic protected-ref comparison.

The browser discovers the latest 100 authoritative review envelopes, resolves
an existing proposal, opens exact immutable evidence, displays literal patches,
approves and self-revokes with the configured human identity. It does not invent
reviews or CI evidence. Promotion is a distinct operator action using a distinct
private promoter credential. A reviewer role alone cannot promote; an operator
role alone cannot approve. Native Git checks Project ownership and required
reviewer membership independently.

## Accounts and deployment

The generated account has the roles needed for the selected features. Add more
accounts by explicitly assigning roles in the private web configuration:

```json
"accounts": [
  { "username": "observer", "passwordHash": "scrypt$16384$8$1$BASE64_SALT$BASE64_32_BYTE_HASH", "roles": ["read"] },
  { "username": "operator", "passwordHash": "scrypt$16384$8$1$BASE64_SALT$BASE64_32_BYTE_HASH", "roles": ["read", "operator"] },
  { "username": "reviewer", "passwordHash": "scrypt$16384$8$1$BASE64_SALT$BASE64_32_BYTE_HASH", "roles": ["read", "reviewer"] }
]
```

Use independently generated salts (at least 16 bytes), scrypt `N=16384, r=8,
p=1`, and a 32-byte derived key. Accounts with reviewer authority deliberately
share the configured native reviewer identity; separate native reviewer
identities require separately scoped service configurations.

The listener binds only to loopback. Forward port 9081 over SSH or publish it
through a trusted HTTPS reverse proxy and set `publicOrigin` to that exact
origin in the private configuration. Service configuration, selected DIM host
configuration, SSH keys and CI connections must belong to the service account.
Never bind privileged host credentials into development containers.

For a system service installed by an administrator, use resource bounds and a
lower OOM victim priority than development containers, for example:

```ini
[Service]
Type=simple
User=dim-web
ExecStart=/absolute/node /absolute/dim-web/cli.js serve /absolute/web.json
Restart=on-failure
MemoryMax=512M
CPUQuota=100%
TasksMax=128
OOMScoreAdjust=-500
```

Negative OOM adjustment requires appropriate host privileges; an unprivileged
user service cannot be assumed to lower its score. DIM workspace and CI
containers use positive victim priority. Configure actual paths and account
access before installing the unit; this package does not deploy it implicitly.

## Authentication boundary

Startup requires an absolute owner-only mode-0600 regular configuration file,
without symlinks or multiple hard links, at most 64 KiB. Native credential failure
fails startup; optional host/CI failures are reported per operation.

Password verification has a process-global five-token burst, one-token/second
refill, and at most two simultaneous scrypt derivations. It does not allocate
per-attacker account queues. Unknown users perform the same derivation work.
Sessions are random in-memory HttpOnly SameSite=Strict cookies, Secure under
HTTPS, bounded to 256 active sessions with independent idle/absolute expiry.
Signing in invalidates prior sessions for that account; restart invalidates all.

Every mutation checks exact Origin, synchronizer CSRF token, current session,
and account role before upstream dispatch. Reads require an authenticated role.
Request bodies, subprocess output/time, upstream responses and diagnostics are
bounded. Secrets and backend errors are not reflected to the browser. Logout
clears rendered operations and diagnostics; requests from an earlier session
cannot populate a later session's view.

The operations API lives under `/v1/operations`: `status`,
`hosts/:configuredId/workspaces` (GET and POST allowlisted action),
`hosts/:configuredId/workspaces/create` (operator-only POST with origin and CSRF checks), `ci/jobs`,
`ci/jobs/:uuid`, `ci/jobs/:uuid/cancel`, `ci/jobs/:uuid/retry`, and `ci/workers`.
Review APIs are scoped to `/v1/projects/:project/repositories/:repository/reviews`:
collection GET, proposal `/resolve`, exact review GET, `/approvals`,
`/revocations`, and operator-only `/promotions`. Query strings, unknown methods,
arbitrary proxies, foreign Projects and repositories are rejected.

Reviewer configuration explicitly lists `nativeGit.repositoryIds`. The browser
selector and proposal list use that scope; every resolve, decision and promotion
request includes the selected repository. Add each repository with a repeated
`--repository` when initializing the web configuration.

## Development showcase

The [primitive showcase](showcase/index.html) is a static development artifact
owned by this package. It demonstrates visual states and local interactions,
without service credentials, network requests or review authority. It is not
the authenticated product UI and is not included in the published package.

From the repository root, serve only its asset directory:

```sh
python3 -m http.server 9082 --bind 127.0.0.1 --directory packages/web/showcase
```

Open `http://127.0.0.1:9082/`. The browser script remains plain JavaScript with
`// @ts-check`; the repository tools type check includes it. Fonts and their
license are kept with the showcase. Runtime UI assets stay under `src/assets`,
and executable tests stay under [`tests/web`](../../tests/web). See
[DESIGN.md](DESIGN.md) for the design contract.
