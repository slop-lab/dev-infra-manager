# Public Git source acquisition

`preparePublicGitSource` prepares a temporary bare repository for the existing
Native Git importer. Inputs are a public HTTPS repository URL (port 443), an
optional plain ASCII branch name (at most 255 characters), an owned private
scratch root, the trusted Git
executable and an optional cancellation signal. It returns the bare directory,
the actual selected `refs/heads/...` branch and explicit cleanup. Neither this
helper nor its relay checks out a tree or runs hooks, submodules, filters or
candidate code.

Only credential-free HTTPS URLs up to 2,048 characters without query/fragment
are accepted. DNS must
resolve exclusively to public addresses; private, loopback, shared, link-local,
documentation, multicast and IPv6 transition ranges are conservatively excluded.
All requests pin the selected validated address while retaining the original
hostname for TLS certificate validation. Redirects, authentication challenges,
compressed HTTP responses and non-smart Git response types are rejected.

Git talks only to a random-path loopback relay. The relay forwards exactly
GET info/refs?service=git-upload-pack and POST git-upload-pack to the fixed
upstream repository. It does not expose arbitrary URLs, dumb-HTTP object paths,
alternates, receive-pack or protocol-v2 packfile URI downloads. The upstream
never receives the local relay token or ambient authorization/cookie headers.
A clean Git environment disables ambient configuration, credential helpers,
interactive prompts, proxies, templates and hooks. Only the HTTP protocol to the
relay is enabled, and fetched objects are checked by Git.

One acquisition has a 170-second overall deadline, 256 MiB aggregate HTTP-body
limit, 4 MiB negotiation-body limit and 32 upstream-request limit. Output from
Git is bounded and errors are sanitized. Abort and failure remove the temporary
repository and close relay connections. The returned cleanup removes successful
acquisitions after the importer finishes. No global cache or workspace state is
changed. Public sources requiring redirects or authentication are unsupported;
operators can use the separate trusted local-path CLI workflow instead.

The optional typed dependencies are server-side test seams for DNS and network
requests and can lower transfer/deadline bounds. They are never read from
browser configuration, repository files or an import payload. Tests retain
public URL validation while routing requests to disposable real Git smart-HTTP
fixtures, and cover DNS pinning, ambient configuration isolation, redirects,
dumb fallback, limits, cancellation and actual branch selection.

The protocol and network mechanisms follow the
[Git HTTP protocol](https://git-scm.com/docs/http-protocol),
[Node HTTPS API](https://nodejs.org/api/https.html) and conservative exclusions
from the [IANA IPv4](https://www.iana.org/assignments/iana-ipv4-special-registry)
and [IPv6](https://www.iana.org/assignments/iana-ipv6-special-registry) special-use
registries. The helper is a constrained source transport, not a hostile-tenant
sandbox for Git itself.
