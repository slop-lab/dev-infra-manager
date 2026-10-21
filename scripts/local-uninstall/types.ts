/** Repository-only removal plan; never part of a published DIM package. */
export type DockerKind = "container" | "network" | "volume";
export interface DockerClaim {
  readonly kind: DockerKind;
  readonly name: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly requiresContainer?: string;
}
export interface RemovalPaths {
  readonly home: string;
  readonly repository: string;
  readonly data: string;
  readonly config: string;
  readonly configuration: string;
  readonly state: string;
  readonly managed: string;
  readonly controlPlane: string;
  readonly hostPlugins: string;
  readonly controlPlanePlugins: string;
  readonly runtime: string;
  readonly bin: string;
  readonly unit: string;
}
