import { cp, mkdtemp, rm, lstat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { UserError } from "@slop-lab/dim-host-core";
import type { CommandRunner, LongOperationOptions } from "@slop-lab/dim-host-core";

export async function buildNativeQemuRunnerImage(
  runner: CommandRunner,
  image: string,
  operation: LongOperationOptions & { readonly profile?: "ubuntu-hardware"; readonly ubuntuImage?: string } = {}
): Promise<void> {
  if (!/^(?:[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?\/)*[a-z0-9]+(?:[._-][a-z0-9]+)*:[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(image)
    || image.endsWith(":latest")) throw new UserError("native QEMU runner image requires an explicit non-latest tag");
  const root = await mkdtemp(join(tmpdir(), "dim-native-qemu-runner-image-"));
  try {
    await cp(fileURLToPath(new URL(operation.profile === "ubuntu-hardware" ? "./ubuntu-hardware-runner-assets" : "./native-qemu-runner-assets", import.meta.url)), root, { recursive: true });
    if (operation.profile === "ubuntu-hardware") {
      const sha = "6a81c37564db9b1ee84e141922625e1d7c5b389b99bb3c572e0243607d5bb4d2";
      const image = operation.ubuntuImage ?? join(homedir(), ".cache/dim/artifacts", sha);
      const info = await lstat(image);
      if (!info.isFile() || info.isSymbolicLink()) throw new UserError("hardware Ubuntu image must be a regular pinned image file");
      const hash = createHash("sha256"); for await (const chunk of createReadStream(image)) hash.update(chunk);
      if (hash.digest("hex") !== sha) throw new UserError("hardware Ubuntu cloud image checksum mismatch");
      await cp(image, join(root, "ubuntu.qcow2"));
    } else if (operation.ubuntuImage !== undefined) throw new UserError("Ubuntu image input requires ubuntu-hardware profile");
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
