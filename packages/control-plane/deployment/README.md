# Managed control-plane deployment

Private service image composition for the selected Git repository, review, merge
policy, workflow and CI integration plugins. This package is not published to npm.
It owns deployment entrypoints and cross-service credential checks; individual
plugins do not depend on it and can be installed independently.

The managed preset includes Git synchronization policy validation and accepts an
explicit `gitSync` section in its private native service configuration:

```json
{
  "gitSync": {
    "operators": [{ "hostId": "operator", "username": "operator-git-sync", "password": "<32-byte base64url token>" }],
    "credential": { "username": "github-username", "password": "<GitHub write token>" }
  }
}
```

`dim control-plane prepare` generates a separate host-bound synchronization
operator. After deployment, `dim control-plane connect` verifies that operator's
live host and generation identity before writing mode-0600 `git-sync.json` beside
`host.json`. Repository fetch, sync and publish commands find that connection
automatically. The upstream `credential` is optional for public fetches and stays
only in the private service configuration; it is never copied to host connection
files or exposed to workspaces. Use a GitHub credential with the permissions
needed for the selected repositories when publication is required.

Existing configurations without `gitSync`, and explicit empty operator lists,
continue to validate repository synchronization policies without granting fetch,
merge or publish authority. To enable synchronization on an existing deployment,
add a unique host-bound operator and optional upstream credential to its private
`native-git.json`, redeploy the reviewed configuration, and connect into a new
connection directory. Never place these credentials in `.dim/repos.yml`; that
file declares repository policy rather than service authority.

After building the workspace packages, build its image from the repository root:

```bash
node packages/control-plane/deployment/image/build.ts dim-git-service:local
node packages/control-plane/plugins/execution-scheduler/image/build.ts dim-execution-scheduler:local
```

Each builder copies its selected compiled packages and image inputs into a
temporary Docker context, then removes that context on completion. The source
checkout, host configuration and unrelated packages are not build inputs.


Native Git activation includes reconciliation of persistent repositories and
proposals. Its exact acknowledgment has a 120-second deadline, with a 130-second
installer Docker exec budget; the short readiness probe remains independent.
