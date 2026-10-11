import { acquireControlPlaneStateLock } from "../../../../core/packages/installer/src/controlPlaneLock.js";

const root = process.argv[2];
if (root === undefined) throw new Error("state root argument is required");

try {
  const lock = await acquireControlPlaneStateLock(root);
  process.stdout.write(`acquired:${JSON.stringify(lock.owner)}\n`);
  process.stdin.resume();
  await new Promise<void>((resolve) => process.stdin.once("end", resolve));
  await lock.close();
} catch (error) {
  process.stdout.write(`rejected:${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 73;
}
