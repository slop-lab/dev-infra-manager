# `@slop-lab/dim-native-git`

DIM-owned Git smart-HTTP transport for registered Project repositories. This
package is a narrow foundation for clone, fetch, and workspace proposal pushes;
it is not an issue tracker, pull-request implementation, review service, or
protected-ref promotion service.

## Security boundary

The service authenticates HTTP Basic identities from a trusted startup
configuration. Every identity is bound to one Project and an explicit set of
repository IDs. A reader may advertise and fetch those repositories. A writer
may additionally create or fast-forward only refs below:

```text
refs/heads/proposals/<workspace-id>/
```

The server-side `pre-receive` policy denies all other refs, proposal deletion,
and non-fast-forward proposal updates. There is deliberately no administrator,
maintainer, or protected-ref write identity in this transport. Until DIM's
separate complete-tree review and compare-and-swap promotion operations are
implemented, protected refs cannot be changed through this service.

Unknown routes, foreign Projects, foreign repositories, malformed paths, and
unregistered repositories are not passed to Git. Both receive-pack discovery
and receive-pack RPC require an authorized writer. The configured absolute Git
executable must be a trusted regular file, report the exact configured
`gitVersion`, and retain the same filesystem identity for the service lifetime.
Registered repository and hook paths reject symbolic links, and each backend
invocation overrides repository-controlled hook and receive policy settings.
Backend process concurrency, request size, and execution time are bounded.

Terminate TLS in a reviewed reverse proxy or expose the service only on a
private isolated network. Basic credentials must not cross an untrusted
plaintext network.

## Configuration

The executable accepts exactly one absolute JSON configuration path:

```bash
dim-native-git /etc/dim/native-git.json
```

The configuration must be a caller-owned, non-symlink, mode-`0600` regular
file because it contains transport credentials.

Example schema-1 configuration:

```json
{
  "schemaVersion": 1,
  "host": "127.0.0.1",
  "port": 9080,
  "storageRoot": "/var/lib/dim/native-git",
  "gitExecutable": "/usr/bin/git",
  "gitVersion": "2.43.0",
  "repositories": [
    { "projectId": "project-a", "repositoryId": "root" }
  ],
  "identities": [
    {
      "role": "writer",
      "username": "workspace-a",
      "password": "replace-with-random-secret",
      "projectId": "project-a",
      "repositoryIds": ["root"],
      "workspaceId": "workspace-a"
    }
  ]
}
```

Trusted host setup calls `initializeNativeRepository` before starting the
service. Registration derives storage only from validated Project and
repository IDs, creates a bare repository below `storageRoot`, pins receive
policy, and installs the proposal-only hook. Initial import is a separate
trusted host operation and is not exposed over HTTP.

## Current integration status

This package is additive and is not selected by `@slop-lab/dim-core` yet.
Existing managed and external Gitea lifecycle behavior remains unchanged. A
later integration must add immutable complete-tree proposals and human review,
then exact-evidence serialized protected promotion satisfying
`TRUST-PROMOTION-001` and `TRUST-PROMOTION-CAS-001`. This transport grants none
of that authority.
