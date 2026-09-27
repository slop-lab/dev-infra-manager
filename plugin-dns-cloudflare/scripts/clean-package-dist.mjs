import { rm } from "node:fs/promises";
import { resolve } from "node:path";
const root = resolve(process.cwd());
const dist = resolve(root, "dist");
if (!dist.startsWith(`${root}/`)) throw new Error(`refusing to clean ${dist}`);
await rm(dist, { recursive: true, force: true });
