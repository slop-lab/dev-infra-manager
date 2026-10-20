import { resolve } from "node:path";
import { buildServiceImage } from "../../../../../scripts/packages/build-service-image.ts";

const root = resolve(import.meta.dirname, "../../../../..");
await buildServiceImage({ imageDirectory: import.meta.dirname,
  packageDirectories: ["contracts/git", "contracts/ci", "control-plane/plugins/ci"]
    .map((directory) => resolve(root, "packages", directory, "dist")) }, process.argv[2] ?? "dim-ci-service:local");
