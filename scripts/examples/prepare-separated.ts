import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { separatedControlPlanePackages } from "./separated-recipes.ts";
import { separatedControlPlaneConfigurations, selectedSeparatedControlPlaneConfigurations } from "./separated-control-plane-composition.ts";
import { separatedOperatorNativeConfiguration } from "./separated-service-config.ts";
import type { prepareControlPlane } from "../../packages/control-plane/admin/src/controlPlaneSetup.js";

/** Fixture-owned selection; the ordinary managed preparation keeps its full preset. */
export async function prepareSeparatedControlPlane(directory: string, prepare?: typeof prepareControlPlane): Promise<void> {
  if (!directory.startsWith("/")) throw new Error("absolute private operator directory required");
  const operation = prepare ?? (await import(pathToFileURL(resolve(import.meta.dirname, "../../packages/control-plane/admin/dist/controlPlaneSetup.js")).href) as { prepareControlPlane: typeof prepareControlPlane }).prepareControlPlane;
  await operation({ directory, nativeGitImage: `example/native@sha256:${"a".repeat(64)}`, executionImage: `example/ci@sha256:${"b".repeat(64)}` });
  const native = JSON.parse(await readFile(join(directory, "native-git.json"), "utf8")) as Record<string, unknown>;
  const execution = JSON.parse(await readFile(join(directory, "execution.json"), "utf8")) as Record<string, unknown>;
  const secret = () => randomBytes(32).toString("base64url");
  const runtime = { generationId: randomBytes(32).toString("hex"), native: { readinessToken: secret(), activationToken: secret() }, ci: { readinessToken: secret(), activationToken: secret() } };
  const selected = await separatedControlPlanePackages(resolve(import.meta.dirname, "../../examples"));
  const configurations = separatedControlPlaneConfigurations(native, execution, runtime, directory);
  selectedSeparatedControlPlaneConfigurations(configurations, selected);
  const configured = separatedOperatorNativeConfiguration(native);
  await writeFile(join(directory, "native-git.json"), JSON.stringify(configured), { mode: 0o600 });
  await writeFile(join(directory, "acceptance-runtime.json"), JSON.stringify(runtime), { mode: 0o600, flag: "wx" });
}
if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const directory = process.argv[2]; if (!directory) throw new Error("absolute private operator directory required");
  await prepareSeparatedControlPlane(directory);
  console.log("Private configuration prepared for the separate control-plane VM");
}
