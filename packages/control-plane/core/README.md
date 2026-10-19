# DIM control-plane runtime

`@slop-lab/dim-control-plane-core` runs explicitly installed, operator-trusted service
plugins without installing DIM workspaces, `dim-host-core`, Docker, or a host controller.
Node 24 or 26 is required. Services may have their own system prerequisites.

Install selected plugins with
`dim installer install control-plane plugin PACKAGE...`; this also installs the
matching runtime into an independent control-plane installation. The installer
prints its `node_modules/.bin/dim-control-plane` path. Run that executable as
`dim-control-plane run /absolute/path/services.json`. Keep this file private
(mode 0600); service configuration contains credentials.

```json
{
  "schemaVersion": 1,
  "plugins": [
    {"package": "@slop-lab/dim-control-plane-plugin-ci-workflows", "config": {}},
    {"package": "@slop-lab/dim-control-plane-plugin-native-git", "config": {
      "service": {}, "stateDirectory": "/var/lib/dim-native-git",
      "readinessToken": "REVIEWED_TOKEN", "activationToken": "REVIEWED_TOKEN",
      "expectedGenerationId": "REVIEWED_GENERATION_SHA256"
    }}
  ]
}
```

Only plugins enabled in that installation’s `plugins.json` may be selected.
`DIM_CONTROL_PLANE_PLUGIN_HOME` selects a separate installation; host
`DIM_PLUGIN_HOME` never affects this runtime. The default is
`$DIM_DATA_HOME/control-plane/runtime/current` (or the usual XDG data location).
Disabling a plugin prevents its next startup; stop the running service to apply it.

The Native Git `service` object must be the complete validated service
configuration described by that plugin, rather than the illustrative empty object.
The workflows plugin supplies the compiler capability; it does not start a CI
execution coordinator or worker. Existing `dim installer install control-plane`
Docker deployment and activation transactions remain separate and unchanged.

The runtime validates all configurations and required capabilities before starting
services. It starts the compiler provider before consumers and closes services in
reverse order on termination or failed startup, continuing cleanup after errors.
Plugins must close their own partially started resources when `start` rejects.
Startup failure never deletes persistent service databases or repository storage.
The `./plugin` SDK contains only structural types. `./lock` provides a private
inode Linux `flock` guard; using that helper also requires the system `flock` tool.
