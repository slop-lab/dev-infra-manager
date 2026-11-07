function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid service configuration");
  return Object.fromEntries(Object.entries(value));
}

/** Placement belongs to the fixture runtime; prepared operator documents stay canonical. */
export function loopbackServiceConfiguration(gitCi: unknown, coordinator: unknown, ports = { native: 8080, execution: 8081 }) {
  if (![ports.native, ports.execution].every((port) => Number.isSafeInteger(port) && port > 0 && port <= 65535) || ports.native === ports.execution) throw new Error("separate service ports must be distinct valid TCP ports");
  const ci = object(gitCi), service = object(coordinator);
  return {
    gitCi: { ...ci, webhook: { ...object(ci.webhook), endpoint: `http://127.0.0.1:${ports.execution}/v1/jobs` } },
    coordinator: { ...service, nativeGit: { ...object(service.nativeGit), endpoint: `http://127.0.0.1:${ports.native}` } }
  };
}

/** Only the disposable preset omits roles for optional services it did not select. */
export function separatedOperatorNativeConfiguration(native: Record<string, unknown>): Record<string, unknown> {
  const { gitSync: _gitSync, webhooks: _webhooks, ...configured } = native;
  return configured;
}
