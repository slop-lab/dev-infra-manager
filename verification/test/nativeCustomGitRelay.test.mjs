import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";

const roots = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(foreign = false) {
  const root = await mkdtemp(join(tmpdir(), "dim-custom-git-"));
  roots.push(root);
  const bin = join(root, "bin");
  const checkout = join(root, "workspace");
  await mkdir(bin);
  await mkdir(checkout);
  execFileSync("git", ["init", checkout]);
  execFileSync("git", ["-C", checkout, "remote", "add", "origin", "http://127.0.0.1:19418/original"]);
  await writeFile(join(checkout, "user-work"), "preserved\n");
  const manifest = join(root, "manifest.json");
  await writeFile(manifest, JSON.stringify({ gitBaseUrl: "http://127.0.0.1:19418/v1/projects/demo/repositories" }));
  const container = { Config: { Labels: { "com.docker.compose.project": "dim-project" } },
    NetworkSettings: { Networks: { "dim-project_default": { NetworkID: "network-id", Gateway: "172.22.0.1" } } } };
  const network = { Name: "dim-project_default", Driver: "bridge", Scope: "local",
    Labels: { "com.docker.compose.project": foreign ? "another-project" : "dim-project",
      "com.docker.compose.network": "default" }, IPAM: { Config: [{ Gateway: "172.22.0.1" }] } };
  await writeFile(join(bin, "docker"), `#!${process.execPath}\nprocess.stdout.write(JSON.stringify([process.argv[2] === "container" ? ${JSON.stringify(container)} : ${JSON.stringify(network)}]));\n`, { mode: 0o755 });
  await writeFile(join(bin, "node"), `#!${process.execPath}\nimport {writeFileSync} from "node:fs";
writeFileSync(process.env.RELAY_CAPTURE, JSON.stringify({mode:process.env.DIM_AGENT_GIT_RELAY_MODE,upstream:process.env.DIM_AGENT_GIT_UPSTREAM,path:process.env.DIM_AGENT_GIT_PATH,phase:process.env.DIM_AGENT_GIT_INITIAL_PHASE}));
process.stdout.write(JSON.stringify({schemaVersion:1,status:"ready",host:process.env.DIM_AGENT_GIT_LISTEN_HOST,port:Number(process.env.DIM_AGENT_GIT_LISTEN_PORT)}));\n`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, DIM_PROJECT_MANIFEST: manifest,
    DIM_WORKSPACE_DATA: root, RELAY_CAPTURE: join(root, "relay.json") };
  return { root, checkout, env };
}

it("rewrites only origin through the native private bridge without fetching or losing user work", async () => {
  const { root, checkout, env } = await fixture();
  const result = spawnSync(process.execPath, [resolve("../.dim/native-agent-git.mjs"), "container-id"], { env, encoding: "utf8" });
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe("http://172.22.0.1:19419/v1/projects/demo/repositories");
  expect(execFileSync("git", ["-C", checkout, "remote", "get-url", "origin"], { encoding: "utf8" }).trim())
    .toBe("http://172.22.0.1:19419/v1/projects/demo/repositories/root.git");
  expect(await readFile(join(checkout, "user-work"), "utf8")).toBe("preserved\n");
  expect(JSON.parse(await readFile(join(root, "relay.json"), "utf8"))).toEqual({ mode: "native",
    upstream: "http://127.0.0.1:19418", path: "/v1/projects/demo/repositories/root.git", phase: "ready" });
});

it("rejects a foreign Compose bridge before starting the relay or changing origin", async () => {
  const { root, checkout, env } = await fixture(true);
  const result = spawnSync(process.execPath, [resolve("../.dim/native-agent-git.mjs"), "container-id"], { env, encoding: "utf8" });
  expect(result.status).not.toBe(0);
  expect(execFileSync("git", ["-C", checkout, "remote", "get-url", "origin"], { encoding: "utf8" }).trim())
    .toBe("http://127.0.0.1:19418/original");
  await expect(readFile(join(root, "relay.json"))).rejects.toMatchObject({ code: "ENOENT" });
});
