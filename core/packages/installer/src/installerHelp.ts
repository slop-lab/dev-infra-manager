export function printFacadeHelp(): void {
  console.log(`DIM installer/facade

DIM CLI is not installed.

Usage:
  dim                         Open the interactive installer
  dim installer               Open the interactive installer
  dim installer install core [options]
  dim installer install plugin PACKAGE@EXACT_VERSION...
  dim installer enable-plugin PACKAGE...
  dim installer disable-plugin PACKAGE...
  dim installer remove-plugin PACKAGE...

Run 'dim installer install core --help' for installation modes.
Source: https://github.com/slop-lab/dev-infra-manager`);
}

export function printInstallerHelp(): void {
  console.log(`Usage:
  dim installer
  dim installer install core [--no-local-bin | --local-bin] [--prefix PATH] [--local-packages PATH]
  dim installer install plugin PACKAGE@EXACT_VERSION...
  dim installer enable-plugin PACKAGE...
  dim installer disable-plugin PACKAGE...
  dim installer remove-plugin PACKAGE...

The installer owns the installer namespace.
All other commands are forwarded unchanged to the installed DIM CLI.`);
}

export function printInstallCoreHelp(): void {
  console.log(`Usage: dim installer install core [options]

Options:
  --no-local-bin  Install privately for facade use without ~/.local/bin/dim
  --local-bin     Create a managed dim symlink in the user bin directory
  --prefix PATH   Use PATH/bin for the managed symlink (default: ~/.local)
  --local-packages PATH
                   Install a packages.json bundle produced by this repository
  -h, --help      Show this help

Under mise, --no-local-bin is the default. Elsewhere, --local-bin is the default.
Using --local-bin under mise may shadow its dim shim, bypass the installer facade,
and make mise version selection differ from the CLI that actually runs.`);
}

export function printInstallPluginHelp(): void {
  console.log(`Usage: dim installer install plugin PACKAGE@EXACT_VERSION...

Options:
  -h, --help  Show this help`);
}
