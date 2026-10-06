import { strict as assert } from "node:assert";
import { describe, it } from "vitest";
import {
  createRecordingRunner,
  publicationProbeArguments
} from "../scripts/control-plane-install-live-mutation.mjs";

describe("control-plane live mutation evidence", () => {
  it("records real runner calls and selects only disposable publication probes", async () => {
    // Given
    const delegated = [];
    const calls = [];
    const delegate = {
      async run(command) {
        delegated.push(command.args);
        return { exitCode: 0, stdout: "ok", stderr: "" };
      }
    };
    const runner = createRecordingRunner(delegate, calls);
    const publication = [
      "run", "--rm", "--pull", "never", "--network", "bridge",
      "--publish", "127.0.0.1:7543:8080", "--read-only"
    ];

    // When
    const result = await runner.run({ args: publication, timeoutMilliseconds: 30_000, maximumOutputBytes: 4096 });
    await runner.run({ args: ["compose", "up", "--force-recreate"], timeoutMilliseconds: 30_000, maximumOutputBytes: 4096 });

    // Then
    assert.equal(result.stdout, "ok");
    assert.deepEqual(delegated, [publication, ["compose", "up", "--force-recreate"]]);
    assert.deepEqual(publicationProbeArguments(calls), [publication]);
  });
});
