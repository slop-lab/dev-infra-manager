import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

export async function gitWholeStoreFence(root: string): Promise<string> {
  const bin = join(root, "git-fence");
  await mkdir(bin);
  await writeFile(join(bin, "git"), `#!/bin/sh
for argument do
  case "$argument" in
    fsck|verify-pack|rev-list|--batch-all-objects) printf 'automatic whole-store inspection rejected by fixture\\n' >&2; exit 93 ;;
  esac
done
exec /usr/bin/git "$@"
`, { mode: 0o700 });
  return `${bin}:${process.env.PATH ?? ""}`;
}
