import { chmod, lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

/** Public job bytes sit beneath a private worker root and a read-only VM mount. */
export async function publishPublicJobFiles(root: string): Promise<void> {
  let entries = 0;
  const visit = async (path: string, depth: number): Promise<void> => {
    if (++entries > 200000 || depth > 70) throw new Error("public job metadata exceeds its traversal bound");
    const info = await lstat(path);
    if (info.isSymbolicLink() || info.uid !== process.getuid?.()) throw new Error("public job metadata ownership mismatch");
    if (info.isDirectory()) {
      for (const name of await readdir(path)) await visit(join(path, name), depth + 1);
      await chmod(path, 0o755);
    } else {
      if (!info.isFile() || info.nlink !== 1) throw new Error("public job metadata must contain only private regular files");
      // Preserve Git's executable-bit identity while normalizing umask 077.
      await chmod(path, (info.mode & 0o111) ? 0o555 : 0o444);
    }
  };
  await visit(root, 0);
}
