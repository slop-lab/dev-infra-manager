import { fileURLToPath } from "node:url";

/** Core owns the tool-neutral guest protocol; each runtime owns installation. */
export function workspaceGuestAssets(): readonly { name: string; sourcePath: string; mode: number }[] {
  return [
    { name: "dim-workspace", source: "dim-workspace.mjs" },
    { name: "dim-nproc", source: "dim-nproc" },
    { name: "dim-workspace-ssh", source: "dim-workspace-ssh.bash" }
  ].map(({ name, source }) => ({
    name, sourcePath: fileURLToPath(new URL(`../workspace-image-assets/${source}`, import.meta.url)), mode: 0o555
  }));
}
