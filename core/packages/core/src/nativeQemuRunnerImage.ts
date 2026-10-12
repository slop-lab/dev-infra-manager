import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { UserError } from "./errors.js";
import type { CommandRunner, LongOperationOptions } from "./types.js";

export async function buildNativeQemuRunnerImage(
  runner: CommandRunner,
  image: string,
  operation: LongOperationOptions = {}
): Promise<void> {
  if (!/^(?:[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?\/)*[a-z0-9]+(?:[._-][a-z0-9]+)*:[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(image)
    || image.endsWith(":latest")) throw new UserError("native QEMU runner image requires an explicit non-latest tag");
  const root = await mkdtemp(join(tmpdir(), "dim-native-qemu-runner-image-"));
  try {
    await cp(fileURLToPath(new URL("./native-qemu-runner-assets", import.meta.url)), root, { recursive: true });
    operation.reportProgress?.("Docker image build");
    const result = await runner.run("docker", ["build", "--tag", image, "."], {
      cwd: root,
      ...(operation.signal === undefined ? {} : { signal: operation.signal })
    });
    if (result.exitCode !== 0) throw new UserError("native QEMU runner image build failed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
