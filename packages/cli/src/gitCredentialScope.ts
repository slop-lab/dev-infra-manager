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

export function gitCredentialArguments(args: readonly string[]): string[] {
  return [
    "-c", "credential.helper=",
    "-c", "credential.helper=!dim git credential-helper",
    ...args
  ];
}
