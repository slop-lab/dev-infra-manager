import { createHash } from "node:crypto";

export type RuntimeNames = {
  readonly container: string;
  readonly network: string;
  readonly home: string;
  readonly checkout: string;
  readonly docker: string;
  readonly tmp: string;
};

export function ownedRuntimeNames(workspaceId: string): RuntimeNames {
  const container = `dim-workspace-${createHash("sha256").update(workspaceId).digest("hex").slice(0, 24)}`;
  return {
    container,
    network: container,
    home: `${container}-home`,
    checkout: `${container}-checkout`,
    docker: `${container}-docker`,
    tmp: `${container}-tmp`
  };
}

export function compareUnrelatedResources(
  before: ReadonlySet<string>,
  after: ReadonlySet<string>,
  owned: ReadonlySet<string>
): readonly string[] {
  const removed = [...before].filter((resource) => !owned.has(resource) && !after.has(resource));
  const added = [...after].filter((resource) => !owned.has(resource) && !before.has(resource));
  return [...removed, ...added].sort();
}

export function ownedResourceKeys(names: RuntimeNames): ReadonlySet<string> {
  return new Set([
    `container:${names.container}`,
    `network:${names.network}`,
    `volume:${names.home}`,
    `volume:${names.checkout}`,
    `volume:${names.docker}`,
    `volume:${names.tmp}`
  ]);
}
