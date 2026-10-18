# Codex in a development workspace

Create a workspace from this repository, then explicitly install the reviewed
Codex tool selection into its persistent home:

```bash
dim create /path/on/selected/host/to/dev-infra-manager development
dim exec development -- bash scripts/dev.bash tool-setup codex
dim exec development -- bash scripts/dev.bash agent codex
```

The user-home installer pins the tool version, checks its installation and
writes its tool manifest. It does not start Codex or perform authentication.
Credentials belong to the workspace user and should be supplied deliberately;
host operator Git, DIM administration and deployment secrets stay outside the
workspace. No coding-agent package is baked into the base runtime image.

`dim exec` runs in the same Sysbox workspace as repository development and
nested Docker. Home and checkout survive stop/start and recreate. There is no
parallel agent daemon, automatic Project hook or SSH proxy requirement. For
ordinary remote hosts and service forwarding, see
[basic-development](../../projects/basic-development/README.md).
