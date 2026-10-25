import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface ServiceImageInputs {
  readonly imageDirectory: string;
  readonly packageDirectories: readonly string[];
}

/** Docker receives only the selected built packages and the image's own inputs. */
export async function withServiceImageContext<T>(inputs: ServiceImageInputs, use: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "dim-service-image-"));
  try {
    for (const file of ["Dockerfile", "package.json", "package-lock.json", "dim-service"]) {
      await cp(join(inputs.imageDirectory, file), join(directory, file));
    }
    const names = new Set<string>();
    for (const source of inputs.packageDirectories) {
      const metadata: unknown = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
      if (!metadata || typeof metadata !== "object" || !("name" in metadata)
        || typeof metadata.name !== "string" || !/^@(slop-lab|this-project)\/[a-z0-9-]+$/.test(metadata.name)) {
        throw new Error(`invalid built service package: ${source}`);
      }
      if (names.has(metadata.name)) throw new Error(`duplicate service package: ${metadata.name}`);
      names.add(metadata.name);
      const target = join(directory, "modules", metadata.name);
      await mkdir(dirname(target), { recursive: true });
      await cp(source, target, { recursive: true });
    }
    return await use(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function buildServiceImage(inputs: ServiceImageInputs, tag: string): Promise<void> {
  if (!tag || tag.startsWith("-")) throw new Error("an image tag is required");
  await withServiceImageContext(inputs, async (directory) => {
    const cancellation = new AbortController();
    const abort = () => cancellation.abort();
    process.once("SIGINT", abort);
    process.once("SIGTERM", abort);
    try {
      await new Promise<void>((resolve, reject) => {
        const quiet = process.env.DIM_SERVICE_IMAGE_QUIET === "1";
        const child = spawn("docker", ["build", ...(quiet ? ["--quiet"] : []), "--tag", tag, directory], { stdio: quiet ? ["ignore", "ignore", "inherit"] : "inherit", signal: cancellation.signal });
        let failure: Error | undefined;
        child.once("error", (error) => { failure = error; });
        child.once("close", (status, signal) => failure ? reject(failure) : status === 0 ? resolve()
          : reject(new Error(`service image build failed (${signal ?? status})`)));
      });
      // Exercise the shipped entry point before publishing a prepared candidate.
      // A successful Docker build alone cannot detect missing runtime imports.
      await new Promise<void>((resolve, reject) => {
        const child = spawn("docker", ["run", "--rm", "--network", "none", "--read-only",
          "--cap-drop", "ALL", "--security-opt", "no-new-privileges", tag, "compatibility", "--json"], {
          stdio: "inherit", signal: AbortSignal.any([cancellation.signal, AbortSignal.timeout(30_000)])
        });
        let failure: Error | undefined;
        child.once("error", (error) => { failure = error; });
        child.once("close", (status, signal) => failure ? reject(failure) : status === 0 ? resolve()
          : reject(new Error(`service image startup check failed (${signal ?? status})`)));
      });
    } finally {
      process.removeListener("SIGINT", abort);
      process.removeListener("SIGTERM", abort);
    }
  });
}
