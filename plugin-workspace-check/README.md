# Workspace lifecycle checks

This optional host plugin tests an ordinary Git source without Project hooks
or a managed control plane:

```sh
dim installer install plugin '@slop-lab/dim-plugin-workspace-check@0.10.0'
dim workspace-check /absolute/path/on/selected/host/to/repository
# Or: dim --host devbox workspace-check https://example.com/team/app.git --image REVIEWED_IMAGE
```

Use `--runtime NAME` to test an explicitly installed runtime plugin, with its
reviewed image selected through `--image` when required.

The command creates a new disposable workspace, writes checkout and home
sentinels, and creates a volume in its nested Docker daemon. It verifies those
three data stores after stop/start and recreation, then discards its own
workspace. It never accepts an existing workspace name. A failing assertion
also discards the test workspace. Cancellation uses a fresh, bounded cleanup
context fenced to the created workspace UUID. Cleanup also removes a partial runtime when creation fails. If the runtime
refuses cleanup, the command fails and reports that error for inspection
through the normal `dim ls` and `dim discard` commands.

Custom tools can supply independent host plugins with their own command names
and assertions through the same `WorkspaceHostPlugin` interface. Test behavior
and repository workflow interpretation stay outside the workspace kernel.
