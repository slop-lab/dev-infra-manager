# DIM control-plane runtime

`@slop-lab/dim-control-plane-core` runs explicitly installed, operator-trusted
service plugins without installing host core, workspaces, Docker or a host
controller. Node 24 or 26 is required. Each service owns its system prerequisites;
the repository plugin additionally needs Git.

## Repository-only installation

The stable installer facade installs selected plugins and the matching runtime
in an independent control-plane tree:

```bash
dim installer install control-plane plugin \
  '@slop-lab/dim-control-plane-plugin-git-repositories@0.10.0'
```

No review, merge, Git-CI, workflow compiler, CI coordinator or worker is selected
by this command. `--local-packages DIRECTORY` uses the exact reviewed source
bundle instead of registry artifacts. The installer prints the runtime's
`node_modules/.bin/dim-control-plane` path.

Create a private configuration for an idle, loopback-only repository service.
This example discovers the installed Git executable/version and generates
separate random activation/readiness tokens and a generation ID:

```bash
DIM_EXAMPLE_GIT="$(command -v git)" node --input-type=module <<'JS'
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { realpathSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const gitExecutable = realpathSync(process.env.DIM_EXAMPLE_GIT);
const gitVersion = /git version (\d+\.\d+\.\d+)/.exec(
  execFileSync(gitExecutable, ['--version'], { encoding: 'utf8' })
)?.[1];
if (gitVersion === undefined) throw new Error('Git version could not be identified');
const config = {
  schemaVersion: 1,
  plugins: [{ package: '@slop-lab/dim-control-plane-plugin-git-repositories', config: {
    service: {
      schemaVersion: 7, serviceId: 'native-main', host: '0.0.0.0', port: 8080,
      storageRoot: '/var/lib/dim-native-git', gitExecutable, gitVersion,
      projectRegistrars: [], projectRootImporters: [],
      projectRootReadIssuers: [], workspaceWriteIssuers: []
    },
    stateDirectory: resolve('repository-state'),
    readinessToken: randomBytes(32).toString('base64url'),
    activationToken: randomBytes(32).toString('base64url'),
    expectedGenerationId: randomBytes(32).toString('hex'),
    listen: { host: '127.0.0.1', port: 8787 }
  } }]
};
writeFileSync('services.json', `${JSON.stringify(config, null, 2)}\n`, {
  mode: 0o600, flag: 'wx'
});
JS
```

Run the printed executable as `dim-control-plane run /absolute/path/services.json`.
The example opens the repository listener but grants no operator role, registers
no Project and starts no capacity. Business operations additionally require
configured role credentials and exact-generation activation. See the
[repository service](../plugins/git-repositories/README.md) for its authority and
extension contract. Stop with SIGINT or SIGTERM; repositories and durable state
are preserved.

## Explicit plugin selection

Only packages enabled in that installation's `plugins.json` may be selected by
the service file. `DIM_CONTROL_PLANE_PLUGIN_HOME` selects another installation;
host `DIM_PLUGIN_HOME` never affects this runtime. The default is
`$DIM_DATA_HOME/control-plane/runtime/current`, with the normal XDG DIM data
location used when `DIM_DATA_HOME` is absent. Restart after changing the enabled
plugin selection. A package installed only as another package's dependency is
not implicitly selected.

Add code-review for human decisions, merge-policy for checked promotion, Git-CI
and a compiler for candidate execution integration, or webhooks for external
delivery. Each has its own strict configuration and private credentials. The
repository service does not import their implementations. The separate
`dim installer install control-plane --config FILE` command manages the fixed
Docker deployment/activation profile; it is not required for this standalone
plugin composition.

## Generic extension lifecycle

The runtime configures every selected plugin, collects generic
`{kind, name, value}` extension contributions and validates duplicate identities
and `requiresExtensions` before starting a service. It does not interpret Git,
review, workflow, CI or routing settings. Feature-owned SDKs define their own
extension values and attachment semantics.

Prepared plugins start in configuration order with the complete selected
extension set and cancellation signal. Services close in reverse order after
termination or startup failure, continuing cleanup after errors. A plugin must
clean its partially started resources if `start` rejects. Startup failure never
deletes persistent databases or repository storage.

The `./plugin-api` SDK contains structural runtime types. `./lock` provides a private
inode Linux kernel guard and requires the system `flock` tool.
