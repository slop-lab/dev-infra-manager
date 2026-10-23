import { runPullRequestJourney } from "./pull-requests.ts";
import { runReviewJourney } from "./review.ts";
import { runBrowserJourney } from "./support/runner.ts";

const journeys = [{ name: "review", run: runReviewJourney }, { name: "pull-requests", run: runPullRequestJourney }];
try {
  const selected = new Set(process.argv.slice(2));
  if ([...selected].some((name) => !journeys.some((journey) => journey.name === name))) throw new Error("Unknown Web journey; choose review or pull-requests");
  for (const journey of journeys) {
    if (selected.size === 0 || selected.has(journey.name)) await runBrowserJourney(journey.name, journey.run);
  }
} catch (error) {
  // The runner emits only fixed labels and artifact paths, never assertion
  // messages that may contain credentials or response bodies.
  console.error(error instanceof Error ? error.message : "Web journey could not start");
  process.exitCode = 1;
}
