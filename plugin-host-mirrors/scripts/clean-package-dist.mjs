import { mkdir, rm } from "node:fs/promises";

const dist = new URL("../dist/", import.meta.url);
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
