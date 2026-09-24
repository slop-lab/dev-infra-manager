export function matchesGitCredentialScope(
  fields: Readonly<Record<string, string>>,
  baseUrl: string
): boolean {
  const scope = new URL(baseUrl);
  if (fields.protocol !== scope.protocol.slice(0, -1) || fields.host !== scope.host) return false;
  const scopePath = scope.pathname.replace(/^\/+|\/+$/g, "");
  if (scopePath === "") return true;
  const credentialPath = fields.path?.replace(/^\/+/, "");
  return credentialPath === scopePath || credentialPath?.startsWith(`${scopePath}/`) === true;
}
