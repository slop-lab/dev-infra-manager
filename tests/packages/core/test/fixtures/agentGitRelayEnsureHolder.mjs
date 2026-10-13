import { ensureRelay } from "../../../../../core/images/project-workspace/agent-git-relay-supervisor.mjs";

if (process.argv[2] === "serve") {
  process.once("disconnect", () => process.exit(0));
  setInterval(() => undefined, 60_000);
} else {
  await ensureRelay({ hash: "a".repeat(64), host: "127.0.0.1", port: 19_419 }, import.meta.filename);
}
