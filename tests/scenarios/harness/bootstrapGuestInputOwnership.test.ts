import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

const helper = new URL("../../../scripts/checks/lib/bootstrap-guest-inputs.bash", import.meta.url);

test.each(["valid", "root-extracted", "root-group", "raw-executable", "raw-world-writable", "raw-special", "foreign-readonly", "symlink", "hardlink", "writable-directory", "wrong-uid"])(
  "guest input assignment handles %s without widening its fixed paths",
  async (scenario) => {
    const root = await mkdtemp(join(tmpdir(), "dim-bootstrap-input-owner-"));
    try {
      const sudo = join(root, "sudo");
      const id = join(root, "id");
      const fixture = join(root, "helper.bash");
      const log = join(root, "commands.log");
      await writeFile(log, "");
      await writeFile(id, '#!/usr/bin/env bash\nif [[ "$1" == -u && "$SCENARIO" == wrong-uid ]]; then printf "0\\n"; elif [[ "$1" == -G && "$SCENARIO" == root-group ]]; then printf "1001 0\\n"; else printf "1001\\n"; fi\n');
      await writeFile(sudo, `#!/usr/bin/env bash
set -euo pipefail
shift
command="$1"; shift
if [[ "$command" == /usr/bin/chown || "$command" == /usr/bin/chmod ]]; then
  printf '%s %s\\n' "$command" "$*" >>"$COMMAND_LOG"
  exit 0
fi
[[ "$command" == /usr/bin/stat ]]
path="\${*: -1}"
if [[ "$2" == '%a:%u:%g' ]]; then
  [[ "$path" == /mnt/dim-inputs/bootstrap-source ]] && printf '500:1001:1001\\n' || printf '400:1001:1001\\n'
  exit 0
fi
owner=1001; file_mode=400; links=1; raw=0
case "$SCENARIO" in
  root-extracted|root-group|raw-executable|raw-world-writable|raw-special) owner=0; file_mode=660; raw=1 ;;
  foreign-readonly) owner=1000 ;;
esac
case "$SCENARIO" in
  raw-executable) file_mode=750 ;;
  raw-world-writable) file_mode=666 ;;
  raw-special) file_mode=4660 ;;
  hardlink) links=2 ;;
esac
case "$path" in
  /mnt/dim-inputs/bootstrap-source)
    if [[ "$raw" == 1 ]]; then printf 'directory:755:2:0:0\\n';
    elif [[ "$SCENARIO" == writable-directory ]]; then printf 'directory:700:2:1001:1001\\n';
    else printf 'directory:500:2:%s:%s\\n' "$owner" "$owner"; fi ;;
  */manifest.json)
    if [[ "$SCENARIO" == symlink ]]; then printf 'symbolic link:777:1:1001:1001\\n';
    else printf 'regular file:%s:1:%s:%s\\n' "$file_mode" "$owner" "$owner"; fi ;;
  */root.bundle)
    printf 'regular file:%s:%s:%s:%s\\n' "$file_mode" "$links" "$owner" "$owner" ;;
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
        ? "/usr/bin/chmod 0400 -- /mnt/dim-inputs/bootstrap-source/root.bundle /mnt/dim-inputs/bootstrap-source/manifest.json\n"
          + "/usr/bin/chown --no-dereference 1001:1001 -- /mnt/dim-inputs/bootstrap-source/root.bundle /mnt/dim-inputs/bootstrap-source/manifest.json\n"
          + "/usr/bin/chmod 0500 -- /mnt/dim-inputs/bootstrap-source\n"
          + "/usr/bin/chown --no-dereference 1001:1001 -- /mnt/dim-inputs/bootstrap-source\n"
        : "");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
);
