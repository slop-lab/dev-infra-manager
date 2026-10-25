import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { managedProjectFixture } from "../../host/plugins/native-git/nativeProjectIntegrationFixture.js";
import { NativeProjectPendingStore } from "../../../packages/host/plugins/native-git/src/nativeProjectPendingStore.js";
import { gitHttpFixture } from "../../support/gitHttpFixture.js";
import { generationId, humanReviewer, cleanupFinalizeFixtures } from "../../control-plane/plugins/git-repositories/nativeRootImportFinalizeFixture.js";
import { initializeOperationsWeb } from "../../../packages/web/core/src/initialize.js";
import { parseWebConfig } from "../../../packages/web/core/src/config.js";
import { createWebServerFromConfigFile } from "../../../packages/web/core/src/server.js";

export async function createNativeManagementBrowserFixture(options: { readonly existingProjectAttachment?: boolean } = {}) {
  const managed = await managedProjectFixture(), git = await gitHttpFixture(), root = await mkdtemp(join(tmpdir(), "dim-web-native-management-"));
  try {
    const targetState = options.existingProjectAttachment ? join(root, "target-host-state") : managed.state;
    const store = options.existingProjectAttachment ? new NativeProjectPendingStore(targetState) : managed.store;
    if (options.existingProjectAttachment) {
      await managed.importRepository("public", "attach-public");
      await managed.importRepository("private", "attach-private");
      await store.create({ name: "taken", projectId: "local-only", ownerHostId: managed.connection.hostId });
    }
    await writeFile(join(managed.root, "reviewer.json"), JSON.stringify({ schemaVersion: 1, serviceId: "native-main", baseUrl: managed.service.origin, generationId, ...humanReviewer }), { mode: 0o600 });
    const settings = join(root, "controller-settings.json"), controller = join(root, "dim-fixture");
    await writeFile(settings, JSON.stringify({ state: targetState, hostFile: managed.hostFile, importerFile: managed.importerConnectionFile, gitOrigin: git.baseUrl }), { mode: 0o600 });
    const entry = fileURLToPath(new URL("./nativeManagementControllerFixture.ts", import.meta.url)), tsx = fileURLToPath(new URL("../../node_modules/tsx/dist/loader.mjs", import.meta.url));
    await writeFile(controller, `#!${process.execPath}\n// @ts-check\nimport {spawnSync} from 'node:child_process';const result=spawnSync(process.execPath,['--disable-warning=DEP0205','--conditions=dim-source','--import',${JSON.stringify(tsx)},${JSON.stringify(entry)},...process.argv.slice(2),'--fixture-settings',${JSON.stringify(settings)}],{stdio:'inherit'});if(result.error)throw result.error;process.exit(result.status??1);\n`, { mode: 0o700 });
    const operations = join(root, "operations.json"), config = join(root, "web.json");
    const hosts = [{ id: "devbox", selector: "fixture", executable: controller }, ...(options.existingProjectAttachment ? [{ id: "otherbox", selector: "fixture", executable: controller }] : [])];
    await writeFile(operations, JSON.stringify({ hosts }), { mode: 0o600 });
    const listener = createServer(); await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
    const address = listener.address(); if (!address || typeof address === "string") throw new Error("fixture port unavailable");
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    const login = await initializeOperationsWeb({ operations, output: config, port: address.port });
    const saved = parseWebConfig(JSON.parse(await readFile(config, "utf8"))), account = saved.accounts[0]; if (!account) throw new Error("fixture account missing");
    await writeFile(config, JSON.stringify({ ...saved, pluginHome: fileURLToPath(new URL("../../", import.meta.url)), plugins: [{ package: "@slop-lab/dim-web-plugin-native-git" }],
      accounts: [account, { ...account, username: "readonly", roles: ["read"] }] }), { mode: 0o600 });
    const web = await createWebServerFromConfigFile(config);
    return { origin: await web.listen(), username: login.username, password: login.password, managed, store, git,
      async close() { await web.close(); await managed.service.close(); await git.close(); await cleanupFinalizeFixtures(); await Promise.all([root, managed.root].map((path) => rm(path, { recursive: true, force: true }))); }
    };
  } catch (error) { await managed.service.close(); await git.close(); await cleanupFinalizeFixtures(); await Promise.all([root, managed.root].map((path) => rm(path, { recursive: true, force: true }))); throw error; }
}
