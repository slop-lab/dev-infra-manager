import { runPullRequestJourney } from "./pull-requests.ts";
import { runReviewJourney } from "./review.ts";
import { runBrowserJourney } from "./support/runner.ts";
import type { JourneyContext } from "./support/context.js";

const journeys = [{ name: "review", run: runReviewJourney }, { name: "pull-requests", run: runPullRequestJourney },
  { name: "pull-requests-early-refresh", run: (context: JourneyContext) => runPullRequestJourney(context, undefined, true) }];
try {
  const selected = new Set(process.argv.slice(2));
  if ([...selected].some((name) => !journeys.some((journey) => journey.name === name))) throw new Error(`Unknown Web journey; choose ${journeys.map(journey => journey.name).join(", ")}`);
  for (const journey of journeys) {
    if (selected.size === 0 || selected.has(journey.name)) await runBrowserJourney(journey.name, journey.run);
  }
} catch (error) {
  // The runner emits only fixed labels and artifact paths, never assertion
  // messages that may contain credentials or response bodies.
  console.error(error instanceof Error ? error.message : "Web journey could not start");
  process.exitCode = 1;
}
