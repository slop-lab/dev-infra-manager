import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stagePages } from "../../tools/opencode-web/stage.ts";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const artifact = process.argv[2], binary = process.argv[3];
if (!artifact || !binary || process.argv.length !== 4) throw new Error("usage: node scripts/checks/opencode-workspace-link.ts BUILT_CLIENT OPENCODE_BINARY");
if (!process.env.DIM_CHROMIUM) throw new Error("DIM_CHROMIUM must select the reviewed Chromium executable");
const site = await mkdtemp(path.join(tmpdir(), "dim-opencode-pages-check-"));
try {
  await stagePages(path.resolve(artifact), site);
  execFileSync("pnpm", ["--dir", "tests", "exec", "tsx", "host/plugins/agent-tools/opencodePages.e2e.ts", path.resolve(artifact)], { cwd: repository, stdio: "inherit", timeout: 60_000 });
  execFileSync("pnpm", ["--dir", "tests", "run", "test:web-opencode-workspace-link"], { cwd: repository, stdio: "inherit", timeout: 180_000,
    env: { ...process.env, DIM_OPENCODE_PAGES_SITE: site, DIM_OPENCODE_BINARY: path.resolve(binary) } });
} finally { await rm(site, { recursive: true, force: true }); }
