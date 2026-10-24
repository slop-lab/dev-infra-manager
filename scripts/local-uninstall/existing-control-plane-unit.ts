import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { metadata } from "./files.ts";
import type { RemovalPaths } from "./types.ts";

export const existingControlPlaneUnitPath = (paths: RemovalPaths) => join(dirname(paths.unit), "dim-existing-control-plane-tunnel.service");
/** Only the private repository installer-owned SSH forwarding service is removable. */
export async function ownedExistingControlPlaneUnit(paths: RemovalPaths): Promise<boolean> {
  const file = existingControlPlaneUnitPath(paths), stat = await metadata(file);
  if (!stat) return false;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || stat.size > 16 * 1024) throw new Error("unsafe DIM existing control-plane SSH unit");
  const unit = await readFile(file, "utf8");
  const starts = unit.split("\n").filter((line) => line.startsWith("ExecStart="));
  if (!unit.startsWith("# Owned by DIM repository install-local existing-control-plane\n")
    || !unit.includes("Description=DIM existing control-plane SSH forwards\n")
    || starts.length !== 1 || !starts[0]?.startsWith('ExecStart=/usr/bin/ssh "-M" "-S" "') || !starts[0]?.includes(' "-N" "-T" ')) throw new Error("DIM existing control-plane SSH unit does not belong to the selected installation");
  return true;
}
