import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

const helper = new URL("../scripts/lib/bootstrap-guest-inputs.bash", import.meta.url);

test.each(["valid", "root-extracted", "symlink", "hardlink", "writable-directory", "wrong-uid"])(
  "guest input assignment handles %s without widening its fixed paths",
  async (scenario) => {
    const root = await mkdtemp(join(tmpdir(), "dim-bootstrap-input-owner-"));
    try {
      const sudo = join(root, "sudo");
      const id = join(root, "id");
      const fixture = join(root, "helper.bash");
      const log = join(root, "commands.log");
      await writeFile(log, "");
      await writeFile(id, '#!/usr/bin/env bash\nif [[ "$1" == -u && "$SCENARIO" == wrong-uid ]]; then printf "0\\n"; else printf "1001\\n"; fi\n');
      await writeFile(sudo, `#!/usr/bin/env bash
set -euo pipefail
shift
command="$1"; shift
if [[ "$command" == /usr/bin/chown || "$command" == /usr/bin/chmod ]]; then
  printf '%s\\n' "$*" >>"$COMMAND_LOG"
  exit 0
fi
[[ "$command" == /usr/bin/stat ]]
if [[ "$2" == '%u:%g' ]]; then printf '1001:1001\\n'; exit 0; fi
path="\${*: -1}"
case "$path" in
  /mnt/dim-inputs/bootstrap-source)
    case "$SCENARIO" in
      writable-directory) printf 'directory:700:2:1000:1000\\n' ;;
      root-extracted) printf 'directory:755:2:0:0\\n' ;;
      *) printf 'directory:500:2:1000:1000\\n' ;;
    esac ;;
  */manifest.json)
    if [[ "$SCENARIO" == symlink ]]; then printf 'symbolic link:777:1:1000:1000\\n'; else printf 'regular file:400:1:1000:1000\\n'; fi ;;
  */root.bundle)
    if [[ "$SCENARIO" == hardlink ]]; then printf 'regular file:400:2:1000:1000\\n'; else printf 'regular file:400:1:1000:1000\\n'; fi ;;
  *) exit 99 ;;
esac
`);
      await Promise.all([chmod(sudo, 0o755), chmod(id, 0o755)]);
      await writeFile(fixture, (await readFile(helper, "utf8"))
        .replaceAll("/usr/bin/sudo", sudo).replaceAll("/usr/bin/id", id));

      const result = spawnSync("bash", ["-c", 'set -euo pipefail; source "$1"; bootstrap_guest_inputs_normalize', "fixture", fixture], {
        encoding: "utf8", env: { ...process.env, SCENARIO: scenario, COMMAND_LOG: log }
      });

      const accepted = scenario === "valid" || scenario === "root-extracted";
      assert.equal(result.status, accepted ? 0 : 2, result.stderr);
      assert.equal(await readFile(log, "utf8"), accepted
        ? "--no-dereference 1001:1001 -- /mnt/dim-inputs/bootstrap-source /mnt/dim-inputs/bootstrap-source/root.bundle /mnt/dim-inputs/bootstrap-source/manifest.json\n"
          + (scenario === "root-extracted" ? "0500 -- /mnt/dim-inputs/bootstrap-source\n" : "")
        : "");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
);
