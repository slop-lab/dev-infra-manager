function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid service configuration");
  return Object.fromEntries(Object.entries(value));
}

/** Placement belongs to the fixture runtime; prepared operator documents stay canonical. */
export function loopbackServiceConfiguration(gitCi: unknown, coordinator: unknown) {
  const ci = object(gitCi), service = object(coordinator);
  return {
    gitCi: { ...ci, webhook: { ...object(ci.webhook), endpoint: "http://127.0.0.1:8081/v1/jobs" } },
    coordinator: { ...service, nativeGit: { ...object(service.nativeGit), endpoint: "http://127.0.0.1:8080" } }
  };
}
