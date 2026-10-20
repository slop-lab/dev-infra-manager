export function within(target: URL, base: URL): boolean {
  return target.origin === base.origin && target.pathname.startsWith(base.pathname);
}
export function repositoryTarget(path: string, endpoint: string): URL | undefined {
  if (!path.startsWith("/") || path.startsWith("//")) return;
  try {
    const decoded = decodeURIComponent(path.split("?", 1)[0]!);
    if (decoded.includes("\\") || decoded.split("/").some((part) => part === "." || part === "..")) return;
    const base = new URL(endpoint), target = new URL(path.slice(1), base);
    return within(target, base) ? target : undefined;
  } catch { return; }
}
