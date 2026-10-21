import { cp } from "node:fs/promises";
import source from "../package.json" with { type: "json" };
import { publishLibrary } from "../../../../../scripts/packages/publish-library.ts";
await cp(new URL("../src/native-qemu-runner-assets", import.meta.url), new URL("../dist/native-qemu-runner-assets", import.meta.url), { recursive: true });
await publishLibrary(new URL("../", import.meta.url), source);
