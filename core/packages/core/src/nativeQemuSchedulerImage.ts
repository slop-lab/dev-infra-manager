import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { UserError } from "./errors.js";
import type { CommandRunner, LongOperationOptions } from "./types.js";

export async function buildNativeQemuSchedulerImage(runner: CommandRunner, image: string,
  operation: LongOperationOptions = {}): Promise<void> {
  if (!/^(?:[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?\/)*[a-z0-9]+(?:[._-][a-z0-9]+)*:[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(image)
    || image.endsWith(":latest")) throw new UserError("native QEMU scheduler image requires an explicit non-latest tag");
  const root = await mkdtemp(join(tmpdir(), "dim-native-qemu-image-"));
  try {
    await cp(fileURLToPath(new URL("./native-qemu-scheduler-assets", import.meta.url)), root, { recursive: true });
    await cp(fileURLToPath(new URL(".", import.meta.url)), join(root, "dist"), { recursive: true,
      filter: (source) => source.endsWith(".js") || !source.includes(".") });
    operation.reportProgress?.("Docker image build");
    const result = await runner.run("docker", ["build", "--tag", image, "."], { cwd: root,
      ...(operation.signal === undefined ? {} : { signal: operation.signal }) });
    if (result.exitCode !== 0) throw new UserError("native QEMU scheduler image build failed");
  } finally { await rm(root, { recursive: true, force: true }); }
}
