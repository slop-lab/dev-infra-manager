import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CandidateExecutionError,
  loadNativeCandidateJobInputs
} from "../../../../core/packages/native-git/src/index.js";
import { git, gitExecutable } from "./candidateExecutionHarness.js";
import {
  nativeCandidateJobInputsFixture,
  type NativeCandidateJobInputsFixture
} from "./nativeCandidateJobInputsHarness.js";

const fixtures: NativeCandidateJobInputsFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
});

describe("native schema-4 candidate job input ref race", () => {
  it("rejects protected-ref movement after all scripts are read", async () => {
    // Given
    const fixture = await nativeCandidateJobInputsFixture("sha1");
    fixtures.push(fixture);
    const entered = join(fixture.root, "all-scripts-read");
    const release = join(fixture.root, "release-last-read");
    const counter = join(fixture.root, "blob-read-count");
    const executable = join(fixture.root, "git-reader");
    await writeFile(executable, `#!/bin/sh
set -eu
case " $* " in
  *" cat-file blob "*)
    count=0
    [ ! -e ${JSON.stringify(counter)} ] || count=$(cat ${JSON.stringify(counter)})
    count=$((count + 1))
    printf '%s' "$count" > ${JSON.stringify(counter)}
    if [ "$count" -eq 3 ]; then
      : > ${JSON.stringify(entered)}
      while [ ! -e ${JSON.stringify(release)} ]; do sleep 0.01; done
    fi
    ;;
esac
exec ${gitExecutable} "$@"
`, { mode: 0o700 });
    const config = { ...fixture.config, gitExecutable: executable };

    // When
    const pending = loadNativeCandidateJobInputs(config, fixture.input);
    await vi.waitFor(() => expect(access(entered)).resolves.toBeUndefined());
    await writeFile(join(fixture.source, "moved.txt"), "moved\n");
    await fixture.commit("move protected head during final script read");
    await writeFile(release, "release\n");

    // Then
    await expect(pending).rejects.toBeInstanceOf(CandidateExecutionError);
  });
});
