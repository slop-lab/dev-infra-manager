import { join } from "node:path";
import { loopbackServiceConfiguration } from "./separated-service-config.ts";
type Entry = readonly [packageName: string, config: unknown];
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid service configuration");
  return Object.fromEntries(Object.entries(value));
}
/** This preset explicitly starts configured feature providers before repository attachment. */
export function separatedControlPlaneConfigurations(native: Record<string, unknown>, ordinary: Record<string, unknown>, runtime: Record<string, unknown>, state: string, ports = { native: 8080, execution: 8081 }): readonly Entry[] {
  // The strict base repository owns none of these feature credentials.
  const { humanReviewers, hostPromoters, ci, gitSync: _gitSync, webhooks: _webhooks, ...repository } = native;
  const placed = loopbackServiceConfiguration(ci, ordinary, ports);
  return [
    ["@slop-lab/dim-control-plane-plugin-ci-workflows", {}],
    ["@slop-lab/dim-control-plane-plugin-git-review", { humanReviewers }],
    ["@slop-lab/dim-control-plane-plugin-git-ci", placed.gitCi],
    ["@slop-lab/dim-control-plane-plugin-git-merge-policy", { hostPromoters }],
    ["@slop-lab/dim-control-plane-plugin-git-repositories", { service: repository, stateDirectory: join(state, "git"), ...object(runtime.native), expectedGenerationId: runtime.generationId, listen: { host: "127.0.0.1", port: ports.native } }],
    ["@slop-lab/dim-control-plane-plugin-execution-scheduler", { service: placed.coordinator, stateDirectory: join(state, "ci"), ...object(runtime.ci), expectedGenerationId: runtime.generationId, listen: { host: "127.0.0.1", port: ports.execution } }]
  ];
}
export function selectedSeparatedControlPlaneConfigurations(configurations: readonly Entry[], selected: ReadonlySet<string>): readonly Entry[] {
  const available = new Set(configurations.map(([name]) => name));
  for (const name of selected) if (!available.has(name)) throw new Error(`no acceptance configuration for declared plugin ${name}`);
  return configurations.filter(([name]) => selected.has(name));
}
