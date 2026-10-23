import { cp } from "node:fs/promises";
import source from "../package.json" with { type: "json" };
import { publishLibrary } from "../../../../../scripts/packages/publish-library.ts";
await cp(new URL("../src/assets", import.meta.url), new URL("../dist/assets", import.meta.url), { recursive: true });
await cp(new URL("../src/review-api.d.ts", import.meta.url), new URL("../dist/review-api.d.ts", import.meta.url));
await publishLibrary(new URL("../", import.meta.url), source);
