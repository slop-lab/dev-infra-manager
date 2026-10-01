export function matchesGitCredentialScope(
  fields: Readonly<Record<string, string>>,
  baseUrl: string
): boolean {
  const scope = new URL(baseUrl);
  if (fields.protocol === undefined || fields.host === undefined || fields.path === undefined) return false;
  let credential: URL;
  try {
    credential = new URL(`${fields.protocol}://${fields.host}/${fields.path.replace(/^\/+/, "")}`);
  } catch (error) {
    if (error instanceof TypeError) return false;
    throw error;
  }
  if (credential.protocol !== scope.protocol || credential.host !== scope.host) return false;
  const scopePath = scope.pathname.replace(/\/+$/, "");
  return scopePath === "" || credential.pathname === scopePath || credential.pathname.startsWith(`${scopePath}/`);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function gitCredentialArguments(
  args: readonly string[],
  cliCommand: readonly string[] = [process.execPath, process.argv[1] ?? "dim"]
): string[] {
  const helper = `!${cliCommand.map(shellQuote).join(" ")} git credential-helper`;
  return [
    "-c", "credential.helper=",
    "-c", `credential.helper=${helper}`,
    "-c", "credential.useHttpPath=true",
    ...args
  ];
}
