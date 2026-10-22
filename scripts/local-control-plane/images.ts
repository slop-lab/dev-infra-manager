import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { checked, type Command } from "../local-uninstall/command.ts";
import { metadata } from "../local-uninstall/files.ts";

export const services = ["native-git", "execution"] as const;
export interface LocalServiceImage { readonly tag: string; readonly id: string }
export type LocalServiceImages = Record<typeof services[number], LocalServiceImage>;
export async function preparedServiceImages(bundle: string, run: Command): Promise<LocalServiceImages> {
  const stat = await metadata(join(bundle, "control-plane-images.json"));
  if (!stat?.isFile() || stat.isSymbolicLink()) throw new Error("prepared control-plane metadata must be a regular non-symlink file");
  const value: unknown = JSON.parse(await readFile(join(bundle, "control-plane-images.json"), "utf8"));
  if (!value || typeof value !== "object" || !("schemaVersion" in value) || value.schemaVersion !== 1) throw new Error("invalid prepared control-plane images");
  const images = value as Record<string, unknown>;
  const result = {} as LocalServiceImages;
  for (const service of services) {
    const entry = images[service] as Partial<LocalServiceImage> | undefined;
    if (!entry || typeof entry.tag !== "string" || !/^dim-local-(native-git|execution):[a-zA-Z0-9_.-]+$/.test(entry.tag)
      || typeof entry.id !== "string" || !/^sha256:[0-9a-f]{64}$/.test(entry.id)) throw new Error(`invalid prepared ${service} image`);
    const id = (await checked(run, "docker", ["image", "inspect", "--format", "{{.Id}}", entry.tag])).trim();
    if (id !== entry.id) throw new Error(`prepared ${service} image changed; run just prepare-local`);
    result[service] = { tag: entry.tag, id };
  }
  return result;
}
