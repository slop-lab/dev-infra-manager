/** Build services from the same archived source and compiled packages as the local bundle. */
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { checked, command } from "./local-uninstall/command.ts";
import { services, type LocalServiceImages } from "./local-control-plane/images.ts";
const [source, bundle, version] = process.argv.slice(2);
if (!source || !bundle || !version || process.argv.length !== 5) throw new Error("Usage: node scripts/prepare-local-control-plane.ts SOURCE BUNDLE VERSION");
const images = {} as LocalServiceImages;
for (const service of services) {
  const tag = `dim-local-${service}:${version}`;
  const script = service === "native-git" ? "packages/control-plane/deployment/image/build.ts" : "packages/control-plane/plugins/execution-scheduler/image/build.ts";
  console.log(`[prepare] build ${service} service image`);
  await new Promise<void>((done, reject) => {
    const child = spawn(process.execPath, [resolve(source, script), tag], { stdio: "inherit", env: { ...process.env, DIM_SERVICE_IMAGE_QUIET: "1" } });
    child.once("error", reject);
    child.once("close", (status) => status === 0 ? done() : reject(new Error(`${service} build failed (${status})`)));
  });
  images[service] = { tag, id: (await checked(command, "docker", ["image", "inspect", "--format", "{{.Id}}", tag])).trim() };
}
await writeFile(join(bundle, "control-plane-images.json"), `${JSON.stringify({ schemaVersion: 1, ...images }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
