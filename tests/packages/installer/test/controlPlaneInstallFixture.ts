import { createHash } from "node:crypto";
import { chmod, lstat, readFile, readdir } from "node:fs/promises";
import type {
  ControlPlaneDockerCommand,
  ControlPlaneDockerCommandResult,
  ControlPlaneDockerRunner
} from "../../../../core/packages/installer/src/controlPlaneDocker.js";
import { ControlPlaneDockerUncertainError } from "../../../../core/packages/installer/src/controlPlaneDocker.js";
import {
  ownedContainer,
  ownedNetwork,
  ownedVolume
} from "./controlPlaneDockerResourceFixture.js";
import {
  runtimeContainer,
  runtimeFromCompose,
  type RuntimeFault,
  type RuntimeService
} from "./controlPlaneRuntimeFixture.js";

export { isolationRuntimeFaults, type RuntimeFault } from "./controlPlaneRuntimeFixture.js";

const networkId = "c".repeat(64);
const nativeId = "1".repeat(64);
const ordinaryId = "2".repeat(64);

export class FirstInstallRunner implements ControlPlaneDockerRunner {
  readonly calls: ControlPlaneDockerCommand[] = [];
  network = false;
  nativeVolume = false;
  ordinaryVolume = false;
  nativeContainer = false;
  ordinaryContainer = false;
  failImageProbe = false;
  composeMode: number | undefined;
  composeText: string | undefined;
  nativeRuntime: RuntimeService | undefined;
  ordinaryRuntime: RuntimeService | undefined;
  failReplacementNumber: number | undefined;
  failActivationService: "native-git" | "ordinary-ci" | undefined;
  failCompletionAfterActivation = false;
  failReadinessEvent: "ready:native" | "ready:ordinary" | undefined;
  failEveryReadiness = false;
  uncertainReadinessEvent: "ready:native" | "ready:ordinary" | undefined;
  readonly readinessEvents: string[] = [];
  readinessStateRoot: string | undefined;
  readinessExpectedInstalled = false;
  readinessGenerationDigestAtFailure: string | undefined;
  uncertainReplacementNumber: number | undefined;
  uncertainStartNumber: number | undefined;
  foreignNetworkOnCreate = false;
  foreignNativeVolumeOnCreate = false;
  runtimeFaultAt: { readonly start: number; readonly kind: RuntimeFault } | undefined;
  runtimeInspectionFault: RuntimeFault | undefined;
  private replacementCount = 0;
  private startCount = 0;

  async run(command: ControlPlaneDockerCommand): Promise<ControlPlaneDockerCommandResult> {
    this.calls.push(command);
    const args = command.args;
    if (args[0] === "compose" && args[1] === "version") return ok("5.0.0\n");
    if (args[0] === "network" && args[1] === "inspect") {
      return this.network ? ownedNetwork(this.foreignNetworkOnCreate) : missing(`network ${args[2] ?? ""} not found`);
    }
    if (args[0] === "volume" && args[1] === "inspect") {
      const name = args[2] ?? "";
      const present = name.includes("native-git") ? this.nativeVolume : this.ordinaryVolume;
      return present ? ownedVolume(name, this.foreignNativeVolumeOnCreate && name.includes("native-git")) : missing(`get ${name}: no such volume`);
    }
    if (args[0] === "container" && args[1] === "inspect") {
      const target = args[2] ?? "";
      const native = target.includes("native-git") || target === nativeId;
      const present = native ? this.nativeContainer : this.ordinaryContainer;
      if (present && args.at(-1)?.includes(".Image")) {
        const runtime = native ? this.nativeRuntime : this.ordinaryRuntime;
        const inspected = runtime === undefined || this.runtimeInspectionFault === undefined
          ? runtime
          : { ...runtime, fault: this.runtimeInspectionFault };
        return inspected === undefined
          ? failed("missing runtime metadata")
          : runtimeContainer(inspected, args.at(-1)?.includes("DeviceRequests") ?? false);
      }
      return present ? ownedContainer(native ? "native-git" : "ordinary-ci") : missing(`No such container: ${target}`);
    }
    if (args[0] === "container" && args[1] === "exec") {
      const id = args[4];
      const service = id === ordinaryId ? "ordinary-ci" : id === nativeId ? "native-git" : undefined;
      if (service === undefined) return failed("service command targeted an unknown container ID");
      const runtime = service === "ordinary-ci" ? this.ordinaryRuntime : this.nativeRuntime;
      if (runtime === undefined) return failed("service command targeted a service without runtime metadata");
      const expectedUser = service === "ordinary-ci" ? "10002:10002" : "10001:10001";
      if (args[6] === "ready") {
        if (args.length !== 7 || args[2] !== "--user" || args[3] !== expectedUser
          || args[5] !== "/usr/local/bin/dim-service") return failed("readiness command differs from the owned runtime");
        const event = service === "ordinary-ci" ? "ready:ordinary" : "ready:native";
        this.readinessEvents.push(event);
        if (this.uncertainReadinessEvent === event) {
          throw new ControlPlaneDockerUncertainError("Docker readiness exec termination could not be established");
        }
        if (this.readinessStateRoot !== undefined) {
          const installed = await exists(`${this.readinessStateRoot}/install.json`);
          if (installed !== this.readinessExpectedInstalled) return failed("readiness observed unexpected installed state");
        }
        if (this.failEveryReadiness || this.failReadinessEvent === event) {
          this.failReadinessEvent = undefined;
          if (this.readinessStateRoot !== undefined) {
            const generations = await readdir(`${this.readinessStateRoot}/generations`);
            this.readinessGenerationDigestAtFailure = await directoryDigest(
              `${this.readinessStateRoot}/generations/${generations[0] ?? "missing"}`
            );
          }
          return failed("readiness refused");
        }
        return ok("");
      }
      const generationId = args[7];
      if (args[2] !== "--user" || args[3] !== expectedUser || args[5] !== "/usr/local/bin/dim-service"
        || args[6] !== "activate" || generationId !== runtime.generationId) {
        return failed("activation command differs from the owned runtime");
      }
      const stateRoot = runtime.generationPath.slice(0, -(runtime.generationId.length + "/generations/".length));
      const installed: unknown = JSON.parse(await readFile(`${stateRoot}/install.json`, "utf8"));
      if (typeof installed !== "object" || installed === null || Reflect.get(installed, "generationId") !== generationId) {
        return failed("activation preceded installed-state publication");
      }
      await lstat(`${stateRoot}/transaction.json`);
      if (this.failActivationService === service) {
        this.failActivationService = undefined;
        return failed("activation failed");
      }
      if (service === "native-git" && this.failCompletionAfterActivation) {
        await chmod(`${stateRoot}/transaction.json`, 0o400);
      }
      return ok("");
    }
    if (args[1] === "ls") return this.list(args);
    if (args[0] === "pull") return ok("");
    if (args[0] === "image") {
      const image = args[2] ?? "";
      if (args.at(-1) === "{{.Id}}") return ok(`sha256:${(image.includes("native-git") ? "d" : "e").repeat(64)}\n`);
      return ok(`${JSON.stringify([image])}\n${JSON.stringify(image.includes("native-git") ? "10001:10001" : "10002:10002")}\n`);
    }
    if (args[0] === "run") {
      if (this.failImageProbe) return failed("probe failed");
      const stateFormat = args.some((entry) => entry.includes("native-git")) ? 8 : 6;
      if (args.includes("compatibility")) {
        return ok(`${JSON.stringify({ schemaVersion: 1, writeFormat: stateFormat, readableFormats: [stateFormat] })}\n`);
      }
      if (args.includes("check-state")) return ok(`${JSON.stringify({ schemaVersion: 1, stateFormat })}\n`);
      return ok("");
    }
    if (args[0] === "network" && args[1] === "create") {
      this.network = true;
      return ok(`${networkId}\n`);
    }
    if (args[0] === "volume" && args[1] === "create") {
      const name = args.at(-1) ?? "";
      if (name.includes("native-git")) this.nativeVolume = true;
      else this.ordinaryVolume = true;
      return ok(`${name}\n`);
    }
    if (args[0] === "compose" && args.includes("config")) {
      const file = composeFile(args);
      this.composeMode = (await lstat(file)).mode & 0o777;
      this.composeText = await readFile(file, "utf8");
      return ok("");
    }
    if (args[0] === "compose" && args.includes("up")) {
      if (args.includes("--force-recreate")) {
        this.replacementCount += 1;
        if (this.replacementCount === this.uncertainReplacementNumber) {
          throw new ControlPlaneDockerUncertainError("Docker command termination could not be established");
        }
        if (this.replacementCount === this.failReplacementNumber) return failed("replacement failed");
      }
      const service = args.at(-1) === "ordinary-ci" ? "ordinary-ci" : "native-git";
      this.startCount += 1;
      if (this.startCount === this.uncertainStartNumber) {
        throw new ControlPlaneDockerUncertainError("Docker command termination could not be established");
      }
      const parsed = runtimeFromCompose(await readFile(composeFile(args), "utf8"), service);
      const fault = this.runtimeFaultAt?.start === this.startCount ? this.runtimeFaultAt.kind : undefined;
      const runtime: RuntimeService = fault === undefined ? parsed : { ...parsed, fault };
      if (service === "ordinary-ci") {
        this.ordinaryContainer = true;
        this.ordinaryRuntime = runtime;
      } else {
        this.nativeContainer = true;
        this.nativeRuntime = runtime;
      }
      return ok("");
    }
    if (args[0] === "container" && args[1] === "rm") {
      if (args.at(-1) === nativeId) this.nativeContainer = false;
      if (args.at(-1) === ordinaryId) this.ordinaryContainer = false;
      return ok(`${args.at(-1) ?? ""}\n`);
    }
    if (args[0] === "network" && args[1] === "rm") {
      this.network = false;
      return ok(`${networkId}\n`);
    }
    return failed(`unexpected command: ${args.join(" ")}`);
  }

  private list(args: readonly string[]): ControlPlaneDockerCommandResult {
    if (args[0] === "network") return ok(this.network ? `${networkId}\n` : "");
    if (args[0] === "volume") {
      return ok([
        ...(this.nativeVolume ? ["dim-control-plane-native-git-data"] : []),
        ...(this.ordinaryVolume ? ["dim-control-plane-ordinary-ci-data"] : [])
      ].map((entry) => `${entry}\n`).join(""));
    }
    if (args.some((entry) => entry === "network=dim-control-plane")) {
      return ok([this.nativeContainer ? nativeId : undefined, this.ordinaryContainer ? ordinaryId : undefined]
        .filter(isString).map((entry) => `${entry}\n`).join(""));
    }
    if (args.some((entry) => entry.includes("native-git-data"))) return ok(this.nativeContainer ? `${nativeId}\n` : "");
    if (args.some((entry) => entry.includes("ordinary-ci-data"))) return ok(this.ordinaryContainer ? `${ordinaryId}\n` : "");
    return ok([this.nativeContainer ? nativeId : undefined, this.ordinaryContainer ? ordinaryId : undefined]
      .filter(isString).map((entry) => `${entry}\n`).join(""));
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function directoryDigest(path: string): Promise<string> {
  const hash = createHash("sha256");
  for (const name of (await readdir(path)).sort()) hash.update(name).update(await readFile(`${path}/${name}`));
  return hash.digest("hex");
}

function composeFile(args: readonly string[]): string {
  const index = args.indexOf("--file");
  const value = args[index + 1];
  if (value === undefined) throw new Error("Compose test command is missing --file");
  return value;
}

function isString(value: string | undefined): value is string {
  return value !== undefined;
}

function ok(stdout: string): ControlPlaneDockerCommandResult {
  return { exitCode: 0, stdout, stderr: "" };
}

function failed(stderr: string): ControlPlaneDockerCommandResult {
  return { exitCode: 1, stdout: "", stderr };
}

function missing(message: string): ControlPlaneDockerCommandResult {
  return { exitCode: 1, stdout: "\n", stderr: `Error response from daemon: ${message}\n` };
}
