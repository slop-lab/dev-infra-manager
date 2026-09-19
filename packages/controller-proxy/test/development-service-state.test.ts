import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDevelopmentServiceGateway } from "../../../../core/packages/controller-proxy/src/development-service-gateway.js";

describe("development service state", () => {
  const cleanup: Array<() => Promise<void>> = [];
  afterEach(async () => Promise.all(cleanup.splice(0).reverse().map((item) => item())));

  it("persists simultaneous different-service registrations across restart", async () => {
    const stateDirectory = await temporaryDirectory("dim-development-state-");
    const gateway = createDevelopmentServiceGateway({ listenPort: 0, stateDirectory });
    await gateway.listen();

    await Promise.all([
      gateway.setRoute(route("alpha", 4101)),
      gateway.setRoute(route("beta", 4102))
    ]);
    await gateway.close();
    const restarted = createDevelopmentServiceGateway({ listenPort: 0, stateDirectory });
    await restarted.listen();
    cleanup.push(() => restarted.close());

    expect((await restarted.getRoute("alpha"))?.targetPort).toBe(4101);
    expect((await restarted.getRoute("beta"))?.targetPort).toBe(4102);
  });

  it("serializes simultaneous updates for one service without corrupting its identity", async () => {
    const stateDirectory = await temporaryDirectory("dim-development-duplicate-");
    const gateway = createDevelopmentServiceGateway({ listenPort: 0, stateDirectory });
    await gateway.listen();

    await Promise.all([
      gateway.setRoute(route("same", 4201, "first")),
      gateway.setRoute(route("same", 4202, "second"))
    ]);
    await gateway.close();
    const restarted = createDevelopmentServiceGateway({ listenPort: 0, stateDirectory });
    await restarted.listen();
    cleanup.push(() => restarted.close());

    expect(await restarted.getRoute("same")).toMatchObject({ urlId: "second", targetPort: 4202 });
    const persisted: unknown = JSON.parse(await readFile(path.join(stateDirectory, "services.json"), "utf8"));
    expect(persisted).toHaveLength(1);
  });

  it("rejects an escaping state-directory symlink before mutating its target", async () => {
    const root = await temporaryDirectory("dim-development-symlink-root-");
    const outside = await temporaryDirectory("dim-development-symlink-outside-");
    const stateDirectory = path.join(root, "state");
    await symlink(outside, stateDirectory, "dir");
    const gateway = createDevelopmentServiceGateway({ listenPort: 0, stateDirectory });

    await expect(gateway.listen()).rejects.toThrow("symbolic link");

    expect(await readdir(outside)).toEqual([]);
  });

  it("rejects a symlinked services file instead of reading outside state", async () => {
    const stateDirectory = await temporaryDirectory("dim-development-file-state-");
    const outside = await temporaryDirectory("dim-development-file-outside-");
    await mkdir(stateDirectory, { recursive: true });
    const outsideFile = path.join(outside, "services.json");
    await writeFile(outsideFile, "[]\n");
    await symlink(outsideFile, path.join(stateDirectory, "services.json"));
    const gateway = createDevelopmentServiceGateway({ listenPort: 0, stateDirectory });

    await expect(gateway.listen()).rejects.toThrow("regular file");

    expect(await readFile(outsideFile, "utf8")).toBe("[]\n");
  });

  async function temporaryDirectory(prefix: string): Promise<string> {
    const directory = await mkdtemp(path.join(tmpdir(), prefix));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    return directory;
  }
});

function route(name: string, targetPort: number, urlId = name) {
  return {
    name,
    urlId,
    url: `https://${name}.example.test`,
    authority: `${name}.example.test`,
    ingress: "https-main",
    targetPort
  };
}
