# Optional DIM managed services

`@slop-lab/dim-managed` owns managed Project workspaces, native Git integration,
review and CI workers, host controllers, plugins, and their deployment assets.
The base `@slop-lab/dim-core` package operates local and remote Git workspaces
without these services. The CLI loads this package only for managed commands.

Managed state defaults to `~/.local/state/dim/managed`, with controller sockets
beneath the runtime directory's `dim/managed` namespace. Set
`DIM_MANAGED_STATE_ROOT` to select another managed state root; `DIM_STATE_ROOT`
is also accepted when an explicit application context supplies it.

Managed workspace images use `dev-infra-managed-workspace:<version>`; base
workspace images use `dev-infra-project-workspace:<version>`. Build the managed
image with `dim managed workspace image build`. `DIM_MANAGED_WORKSPACE_IMAGE`
selects an explicit managed image, with `DIM_WORKSPACE_IMAGE` as a contextual
fallback. Building either default image cannot replace the other feature's image.
