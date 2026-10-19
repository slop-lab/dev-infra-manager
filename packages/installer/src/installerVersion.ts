import { readFile } from "node:fs/promises";

export async function installerVersion(): Promise<string> {
  for (const relative of ["./package.json", "../package.json"]) {
    try {
      const manifest: unknown = JSON.parse(await readFile(new URL(relative, import.meta.url), "utf8"));
      if (hasVersion(manifest)) return manifest.version;
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
  }
  throw new Error("could not determine @slop-lab/dim-installer version");
}

function hasVersion(value: unknown): value is { readonly version: string } {
  return typeof value === "object" && value !== null && "version" in value && typeof value.version === "string";
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
}
