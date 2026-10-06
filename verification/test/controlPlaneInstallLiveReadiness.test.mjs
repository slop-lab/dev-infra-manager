import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  builtImageReadinessCases,
  runBuiltImageReadinessMatrix,
  runDependencyReadinessTransition
} from "../scripts/control-plane-install-live-readiness.mjs";

const images = {
  nativeGit: `registry.test/native-git@sha256:${"1".repeat(64)}`,
  ordinaryCi: `registry.test/ordinary-ci@sha256:${"2".repeat(64)}`
};

describe("control-plane live readiness evidence", () => {
  it("runs every named response case in each image without networking or token disclosure", async () => {
    const commands = [];
    const lines = [];
    const token = "private-readiness-token";
    const runner = {
      async run(command) {
        commands.push(command);
        const caseArgument = command.args.find((argument) => argument.startsWith("READINESS_CASE="));
        const name = caseArgument?.slice("READINESS_CASE=".length);
        return {
          exitCode: 0,
          stdout: `${JSON.stringify({ exitCode: name === "exact-response" ? 0 : 1, elapsedMilliseconds: 25 })}\n`,
          stderr: ""
        };
      }
    };

    await runBuiltImageReadinessMatrix({
      runner,
      images,
      tokenPath: "/private/readiness.token",
      forbiddenValues: [token],
      writeLine: (line) => lines.push(line)
    });

    assert.equal(commands.length, builtImageReadinessCases.length * 2);
    for (const command of commands) {
      assert.equal(command.args.includes("--rm"), true);
      assert.equal(command.args.includes("--network"), true);
      assert.equal(command.args[command.args.indexOf("--network") + 1], "none");
      assert.match(command.args.join(" "), /--user (10001:10001|10002:10002)/);
      assert.match(command.args.join(" "), /dst=\/run\/secrets\/readiness\.token,readonly/);
      assert.equal(command.args.join("\0").includes(token), false);
      assert.equal(command.timeoutMilliseconds <= 6_000, true);
    }
    assert.equal(lines.length, builtImageReadinessCases.length * 2);
    for (const service of ["native-git", "ordinary-ci"]) {
      for (const name of builtImageReadinessCases) {
        assert.equal(lines.some((line) => line.includes(`service=${service} case=${name} `)), true);
      }
    }
    assert.equal(lines.join("\n").includes(token), false);
  });

  it("targets saved service IDs and restores healthy unchanged runtime after dependency outages", async () => {
    const nativeId = "a".repeat(64);
    const ordinaryId = "b".repeat(64);
    const calls = [];
    let nativeRunning = true;
    let ordinaryRunning = true;
    const runner = {
      async run(command) {
        calls.push(command.args);
        const [kind, action, ...rest] = command.args;
        if (kind === "container" && action === "stop") {
          if (rest[0] === nativeId) nativeRunning = false;
          if (rest[0] === ordinaryId) ordinaryRunning = false;
          return result(0);
        }
        if (kind === "container" && action === "start") {
          if (rest[0] === nativeId) nativeRunning = true;
          if (rest[0] === ordinaryId) ordinaryRunning = true;
          return result(0);
        }
        if (kind === "container" && action === "exec") {
          const id = rest[2];
          if (id === ordinaryId) return result(ordinaryRunning ? 0 : 1);
          if (id === nativeId) return result(nativeRunning && ordinaryRunning ? 0 : 1);
        }
        throw new Error(`unexpected command ${command.args.join(" ")}`);
      }
    };
    const runtime = { nativeGit: { id: nativeId }, ordinaryCi: { id: ordinaryId } };
    const volumes = [{ Name: "native" }, { Name: "ordinary" }];
    const state = { activation: "unchanged" };
    const lines = [];

    await runDependencyReadinessTransition({
      runner,
      runtime,
      volumes,
      state,
      captureRuntime: async () => runtime,
      captureVolumes: async () => volumes,
      captureState: async () => state,
      writeLine: (line) => lines.push(line)
    });

    assert.equal(nativeRunning, true);
    assert.equal(ordinaryRunning, true);
    assert.deepEqual(calls.filter((args) => args[1] === "stop").map((args) => args[2]), [nativeId, ordinaryId]);
    assert.equal(calls.every((args) => !args.includes("dim-control-plane-native-git-1")
      && !args.includes("dim-control-plane-ordinary-ci-1")), true);
    assert.match(lines.join("\n"), new RegExp(`native=${nativeId} ordinary=${ordinaryId}`));
    assert.match(lines.join("\n"), /ordinary-with-native-stopped exit=0/);
    assert.match(lines.join("\n"), /native-with-ordinary-stopped exit=1/);
    assert.match(lines.join("\n"), /restored healthy=true state=unchanged volumes=unchanged/);
  });
});

function result(exitCode) {
  return { exitCode, stdout: "", stderr: exitCode === 0 ? "" : "readiness failed\n" };
}
