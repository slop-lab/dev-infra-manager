import { rm } from "node:fs/promises";
import { resolve } from "node:path";

const packageRoot = resolve(process.cwd());
const dist = resolve(packageRoot, "dist");
if (dist === packageRoot || !dist.startsWith(`${packageRoot}/`)) {
  throw new Error(`refusing to clean unexpected dist path: ${dist}`);
}
await rm(dist, { recursive: true, force: true });
