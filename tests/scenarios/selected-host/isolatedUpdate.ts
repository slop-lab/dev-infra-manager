import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInstallCommand, type Command } from "../../../scripts/local-uninstall/command.ts";
import { localArtifacts } from "../../../scripts/local-source-runtime.ts";
import { OperatorInputError, ownedWorkspaceName, smokeWorkspaceName, type IsolatedUpdateProfile, type OwnedWorkspace } from "./config.js";
import { guestNestedData } from "./nestedData.js";

export async function verifyIsolatedInstallationUpdate(profile: IsolatedUpdateProfile): Promise<{ readonly workspaceId: string; readonly beforeVersion: string; readonly afterVersion: string; readonly beforeArtifactsSha256: string; readonly afterArtifactsSha256: string }> {
  const preflight = createInstallCommand(process.env);
  const runtimes = await checked(preflight, "docker", ["info", "--format", "{{json .Runtimes}}"]);
  if (!runtimes.includes("sysbox-runc")) throw new OperatorInputError("isolated update requires Sysbox on this disposable runtime host; no installation was created");
  const before = await bundleIdentity(profile.beforeBundle), afterBundle = await bundleIdentity(profile.afterBundle);
  const beforeVersion = before.version, afterVersion = afterBundle.version;
  if (before.sha256 === afterBundle.sha256) throw new OperatorInputError("isolated update requires different reviewed before/after artifact closures; a no-op is not update acceptance");
  const root = await mkdtemp(path.join(tmpdir(), "dim-smoke-isolated-update-")), home = path.join(root, "home");
  await mkdir(home, { mode: 0o700 });
  const env = isolatedEnvironment(root, home), run = createInstallCommand(env), name = smokeWorkspaceName("dim-smoke-update");
  let owned: OwnedWorkspace | undefined, completed = false, failure: unknown;
  const facade = (entry: string, args: readonly string[]) => checked(run, process.execPath, [entry, ...args]);
  try {
    const source = path.join(root, "source"); await mkdir(source);
    await checked(run, "git", ["init", "--initial-branch=main", source]);
    await writeFile(path.join(source, "README.md"), "Isolated installation update acceptance.\n");
    await checked(run, "git", ["-C", source, "add", "."]);
    await checked(run, "git", ["-C", source, "-c", "user.name=DIM smoke", "-c", "user.email=smoke@example.invalid", "commit", "-m", "isolated source"]);
    await facade(profile.beforeFacade, ["installer", "install", "core", "--local-packages", profile.beforeBundle, "--no-local-bin"]);
    await facade(profile.beforeFacade, ["installer", "install", "plugin", "--local-packages", profile.beforeBundle, `@slop-lab/dim-host-plugin-agent-tools@${beforeVersion}`]);
    if ((await facade(profile.beforeFacade, ["--host", "local", "--version"])).trim() !== beforeVersion) throw new OperatorInputError("isolated initial host version differs from reviewed bundle");
    const created: unknown = JSON.parse(await facade(profile.beforeFacade, ["--host", "local", "create", source, name, "--image", profile.image, "--json"]));
    owned = ownedWorkspaceName(name, created);
    await facade(profile.beforeFacade, ["--host", "local", "exec", name, "--", "node", "-e", guestNestedData, "write", owned.id, "isolated-nested-retained"]);
    const token = randomBytes(32).toString("base64url");
    const app = path.join(root, "authenticated-service.cjs");
    await writeFile(app, `const fs=require("node:fs"),os=require("node:os"),path=require("node:path");const token=${JSON.stringify(token)};require("node:http").createServer((request,response)=>{if(request.headers.authorization!=="Bearer "+token){response.writeHead(401).end();return;}response.end("retained-service");}).listen(3001,"127.0.0.1");\n`, { mode: 0o600 });
    await facade(profile.beforeFacade, ["--host", "local", "cp", app, `${name}:/home/dim/isolated-service.cjs`]);
    const key = path.join(root, "service-token"); await writeFile(key, token, { mode: 0o600 });
    await facade(profile.beforeFacade, ["--host", "local", "cp", key, `${name}:/home/dim/isolated-service-token`]);
    await facade(profile.beforeFacade, ["--host", "local", "exec", name, "--", "dim-workspace", "service", "register", "--name", "isolated-service", "--", "node", "/home/dim/isolated-service.cjs"]);
    await facade(profile.beforeFacade, ["--host", "local", "exec", name, "--", "dim-workspace", "service", "resume"]);
    const probe = `const fs=require("node:fs");(async()=>{const token=fs.readFileSync("/home/dim/isolated-service-token","utf8");const denied=await fetch("http://127.0.0.1:3001");if(denied.status!==401)throw Error("auth boundary changed");const response=await fetch("http://127.0.0.1:3001",{headers:{authorization:"Bearer "+token}});if(response.status!==200||await response.text()!=="retained-service")throw Error("service or credential changed");process.stdout.write("retained-auth-service");})().catch(e=>{console.error(e.message);process.exitCode=1})`;
    await facade(profile.beforeFacade, ["--host", "local", "exec", name, "--", "node", "-e", probe]);
    await facade(profile.afterFacade, ["installer", "install", "core", "--local-packages", profile.afterBundle, "--no-local-bin"]);
    if ((await facade(profile.afterFacade, ["--host", "local", "--version"])).trim() !== afterVersion) throw new OperatorInputError("updated host version differs from reviewed bundle");
    const plugin: unknown = JSON.parse(await readFile(path.join(root, "data/dim/runtime/current/node_modules/@slop-lab/dim-host-plugin-agent-tools/package.json"), "utf8"));
    if (!plugin || typeof plugin !== "object" || !("version" in plugin) || plugin.version !== afterVersion) throw new OperatorInputError("enabled agent-tools plugin did not update with its host runtime");
    const after: unknown = JSON.parse(await facade(profile.afterFacade, ["--host", "local", "show", name, "--json"]));
    if (!after || typeof after !== "object" || !("id" in after) || after.id !== owned.id || !("runtimeStatus" in after) || after.runtimeStatus !== "running") throw new OperatorInputError("isolated update did not retain the exact running workspace");
    if ((await facade(profile.afterFacade, ["--host", "local", "exec", name, "--", "node", "-e", probe])).trim() !== "retained-auth-service") throw new OperatorInputError("isolated update lost service/auth continuity");
    await facade(profile.afterFacade, ["--host", "local", "exec", name, "--", "node", "-e", guestNestedData, "read", owned.id, "isolated-nested-retained"]);
    completed = true; return { workspaceId: owned.id, beforeVersion, afterVersion, beforeArtifactsSha256: before.sha256, afterArtifactsSha256: afterBundle.sha256 };
  } catch (error) {
    failure = error; throw new OperatorInputError(`isolated update failed; private fixture retained at ${root}`, { cause: error });
  } finally {
    if (owned !== undefined) {
      try { await facade(profile.afterFacade, ["--host", "local", "discard", name, "--expect-id", owned.id, "--yes"]); }
      catch (cleanupError) { throw new AggregateError([...(failure === undefined ? [] : [failure]), cleanupError], `isolated update cleanup unconfirmed; private fixture retained at ${root}`); }
    }
    if (completed) await rm(root, { recursive: true, force: true });
  }
}

export function isolatedEnvironment(root: string, home: string): NodeJS.ProcessEnv {
  const selected: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "LANG", "LC_ALL", "TZ", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "SSL_CERT_FILE", "SSL_CERT_DIR"]) {
    const value = process.env[name]; if (value !== undefined) selected[name] = value;
  }
  return { ...selected, HOME: home, XDG_CONFIG_HOME: path.join(root, "config"), XDG_DATA_HOME: path.join(root, "data"),
    XDG_STATE_HOME: path.join(root, "xdg-state"), XDG_RUNTIME_DIR: path.join(root, "run"), DIM_DATA_HOME: path.join(root, "data/dim"),
    DIM_CONFIG_PATH: path.join(root, "config/dim/config.json"), DIM_STATE_ROOT: path.join(root, "state"),
    DIM_MANAGED_STATE_ROOT: path.join(root, "managed"), DIM_INSTALL_PREFIX: path.join(root, "prefix") };
}

async function checked(run: Command, executable: string, args: readonly string[]): Promise<string> {
  const response = await run(executable, args);
  if (response.status !== 0) throw new OperatorInputError(`isolated update operation ${path.basename(executable)} ${args[0] ?? ""} exited ${response.status}; private fixture retained`);
  return response.stdout;
}
async function bundleIdentity(bundle: string): Promise<{ readonly version: string; readonly sha256: string }> {
  const artifacts = localArtifacts(JSON.parse(await readFile(path.join(bundle, "packages.json"), "utf8")), ["@slop-lab/dim-host-core", "@slop-lab/dim-host-plugin-agent-tools"]);
  const core = artifacts.find(({ name }) => name === "@slop-lab/dim-host-core");
  if (!core) throw new OperatorInputError("reviewed isolated update bundle contains no host core");
  const hash = createHash("sha256");
  for (const artifact of artifacts) hash.update(JSON.stringify(artifact)).update(await readFile(path.join(bundle, artifact.file)));
  return { version: core.version, sha256: hash.digest("hex") };
}
