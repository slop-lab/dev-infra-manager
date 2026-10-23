import { runWorkspaceAgent } from "./workspace-agent.js";

try {
  const configuration = process.argv[2];
  if (process.argv.length !== 3 || !configuration) throw new Error("workspace bridge requires exactly one private configuration path");
  await runWorkspaceAgent(configuration);
} catch (error) {
  console.error(error instanceof Error ? error.message : "workspace bridge failed");
  process.exitCode = 1;
}
