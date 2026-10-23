import source from "../package.json" with { type: "json" };
import { publishLibrary } from "../../../../scripts/packages/publish-library.ts";
await publishLibrary(new URL("../", import.meta.url), source);
