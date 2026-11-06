import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isAbsolute, join } from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { prepareSmokeProfile } from "../../../../tests/scenarios/selected-host/profilePreparation.ts";

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--help") {
  console.log("Ordinary runtime recipe: set DIM_SMOKE_CONFIG and DIM_SMOKE_HOSTS, or DIM_SMOKE_BINDINGS and DIM_EXAMPLE_PACKAGE_BUNDLE to derive a private profile. --verify-vm always executes the full smoke, never preflight-only.");
} else {
  if (args.length > 1 || args.length === 1 && args[0] !== "--verify-vm") throw new Error("unknown ordinary runtime recipe argument; use --help");
  if (args[0] === "--verify-vm" && process.env.DIM_SMOKE_PREFLIGHT_ONLY === "1") throw new Error("VM acceptance cannot use preflight-only mode");
  if (args[0] === "--verify-vm" && process.env.DIM_PRACTICAL_CI_REQUIRED === "1") {
    await import("../../../../tests/scenarios/selected-host/ci/host.ts");
    process.exit(process.exitCode ?? 0);
  }
  let config = process.env.DIM_SMOKE_CONFIG, hosts = process.env.DIM_SMOKE_HOSTS?.split(","), temporary: string | undefined;
  try {
    if (config === undefined && process.env.DIM_SMOKE_BINDINGS !== undefined) {
      const bundle = process.env.DIM_EXAMPLE_PACKAGE_BUNDLE;
      if (!bundle || !isAbsolute(bundle) || !isAbsolute(process.env.DIM_SMOKE_BINDINGS)) throw new Error("bindings and reviewed package bundle paths must be absolute");
      const sourceSha = /^root=([a-f0-9]{40})$/m.exec(await readFile(join(bundle, ".dim-source-state"), "utf8"))?.[1];
      if (!sourceSha) throw new Error("reviewed package bundle has no exact source identity");
      temporary = await mkdtemp(join(tmpdir(), "dim-smoke-profile-"));
      const key = join(temporary, "guest-test-key");
      execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "dim-smoke", "-f", key]);
      const profile = prepareSmokeProfile({ bindings: JSON.parse(await readFile(process.env.DIM_SMOKE_BINDINGS, "utf8")),
        artifacts: JSON.parse(await readFile(join(bundle, "packages.json"), "utf8")), sourceSha, sshPublicKey: (await readFile(`${key}.pub`, "utf8")).trim() });
      config = join(temporary, "hosts.json");
      await writeFile(config, `${JSON.stringify(profile)}\n`, { mode: 0o600, flag: "wx" });
      hosts ??= profile.hosts.map(({ name }) => name);
    }
    if (!config || !isAbsolute(config) || !hosts?.length || hosts.some((name) => !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$/.test(name))) {
      throw new Error("Set an absolute DIM_SMOKE_CONFIG and explicit DIM_SMOKE_HOSTS, or DIM_SMOKE_BINDINGS with a reviewed DIM_EXAMPLE_PACKAGE_BUNDLE; no current host is selected implicitly");
    }
    const entry = fileURLToPath(new URL("../../../../scripts/checks/selected-host-usability-smoke.ts", import.meta.url));
    const loader = fileURLToPath(new URL("../../../../tests/node_modules/tsx/dist/loader.mjs", import.meta.url));
    const child = spawn(process.execPath, ["--import", loader, entry, "--config", config, ...hosts.flatMap((host) => ["--host", host]),
      ...(process.env.DIM_SMOKE_PREFLIGHT_ONLY === "1" ? ["--preflight-only"] : [])], { stdio: "inherit" });
    child.once("error", (error) => { console.error(error.message); process.exitCode = 1; });
    await new Promise<void>((resolve) => child.once("close", (code) => { process.exitCode = code ?? 1; resolve(); }));
  } finally { if (temporary !== undefined) await rm(temporary, { recursive: true, force: true }); }
}
