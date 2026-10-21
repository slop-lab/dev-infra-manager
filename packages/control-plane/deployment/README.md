# Managed control-plane deployment

Private service image composition for the selected Git repository, review, merge
policy, workflow and CI integration plugins. This package is not published to npm.
It owns deployment entrypoints and cross-service credential checks; individual
plugins do not depend on it and can be installed independently.

The managed preset includes Git synchronization policy validation, so explicitly
reviewed repository manifests can declare upstream and publish mappings during
import. Its synchronization operator list is empty: the preset grants no fetch,
merge or publish authority. Those operations require an explicitly configured
`git-sync` operator in a separately composed service configuration.

After building the workspace packages, build its image from the repository root:

```bash
node packages/control-plane/deployment/image/build.ts dim-git-service:local
node packages/control-plane/plugins/execution-scheduler/image/build.ts dim-execution-scheduler:local
```

Each builder copies its selected compiled packages and image inputs into a
temporary Docker context, then removes that context on completion. The source
checkout, host configuration and unrelated packages are not build inputs.
