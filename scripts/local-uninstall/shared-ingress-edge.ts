/** Source-install retention selection, deliberately outside published DIM contracts. */
import { join } from "node:path";
import { metadata, object, readJson, text } from "./files.ts";
import type { RemovalPaths } from "./types.ts";
export async function selectedSharedIngressEdge(paths: RemovalPaths): Promise<{ name: string; directory: string; container: string; volumes: string[] } | undefined> {
  const file = join(paths.configuration, "shared-ingress/edge.json"), stat = await metadata(file);
  if (!stat) return;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600 || stat.size > 4096) throw new Error("shared ingress edge selection must be an owned mode-0600 regular file");
  const row = object(await readJson(file)), name = text(row.ingressName);
  if (row.schemaVersion !== 1 || Object.keys(row).some((key) => !["schemaVersion", "ingressName"].includes(key)) || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) throw new Error("invalid source-install shared ingress edge selection");
  const directory = join(paths.state, "plugins/external-urls/caddy", name), root = await metadata(directory);
  if (!root?.isDirectory() || root.isSymbolicLink() || root.uid !== process.getuid?.()) throw new Error("selected shared ingress edge deployment is missing or unsafe");
  return { name, directory, container: `dim-caddy-${name}`, volumes: [`${name}_caddy-data`, `${name}_caddy-config`] };
}
