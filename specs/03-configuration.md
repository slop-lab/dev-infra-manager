# Configuration

## Scope

This specification defines the JSON configuration used by the bare-Git review
controller and secret-runtime deployment. Workspace lifecycle configuration is
stored separately under `DIM_STATE_ROOT`.

## Fields

- `stateRoot`: required non-empty string, normalized to an absolute path.
- `managedGitHost`: required `bare-git-pr` configuration with a remote and at
  least one valid protected full ref.
- `secretRuntime`: required approved ref, image, container, build context,
  optional env file, and publish list.

The config does not contain job storage, resource profiles, timeouts, agent
images, or workspace runtime backends.

Invalid configuration must fail before host mutation.
