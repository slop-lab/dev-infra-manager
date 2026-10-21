# Native Git Web plugin

`@slop-lab/dim-web-plugin-native-git` owns repository review browsing, exact
candidate evidence and patches, proposal resolution, approval/revocation and
protected promotion. The server owns review policy and promotion authority.

Configure the plugin with caller-owned mode-0600 connection files:

```json
{
  "reviewerConnection":"/absolute/reviewer.json",
  "promoterConnection":"/absolute/promoter.json",
  "syncConnection":"/absolute/git-sync.json",
  "projectId":"my-project",
  "repositoryIds":["public","private"]
}
```

The reviewer connection uses the generated Web reviewer connection format
(`schemaVersion`, `serviceId`, `baseUrl`, `generationId`, `reviewerId`, `username`,
`password`). The optional generated host-promoter connection uses `endpoint`, `role`, `hostId`,
`generationId` and nested `credential` fields and must match the reviewer endpoint
and generation. Both serving identities are attested
before loading the plugin. No connection paths or credentials reach the browser.

Every request is confined to the configured project and repositories. Read-only
users can inspect evidence; `reviewer` users can resolve/approve/revoke reviews;
`operator` users can promote only when a promoter connection is configured.
Protection policies remain authoritative when the button is available.

An optional generated `git-sync-operator` connection enables upstream fetch,
merge proposals and explicit non-force publication. Its endpoint, generation and
serving identity must match Native Git (and the promoter host when configured).
Upstream merging produces a proposal; it does not bypass protected review.
