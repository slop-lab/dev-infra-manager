// @ts-check
/**
 * The application owns this rule. Changes to this file or its directory always
 * require security review, independently of the boolean this function returns.
 * @param {readonly {oldPath?: string, newPath?: string, before?: string, after?: string}[]} changes
 */
export function matches(changes) {
  for (const change of changes) {
    if (![change.oldPath, change.newPath].includes("app/config.json")) continue;
    const before = JSON.parse(change.before ?? "{}");
    const after = JSON.parse(change.after ?? "{}");
    // Presentation settings can change without the security reviewer. These
    // application-specific fields change the execution boundary.
    for (const key of ["allowHostAccess", "allowedCommands", "credentialScope"]) {
      if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) return true;
    }
  }
  return false;
}
