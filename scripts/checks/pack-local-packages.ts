import path from "node:path";
import { packLocalPackages } from "../pack-local-packages.ts";

const outputDirectory = process.argv[2];
if (!outputDirectory) throw new Error("output directory is required");
const packages = packLocalPackages(process.cwd(), outputDirectory);
console.log(`Packed ${packages.length} packages in ${outputDirectory}`);
console.log(`Manifest: ${path.join(outputDirectory, "packages.json")}`);
