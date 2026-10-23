import { runReviewJourney } from "./review.ts";
import { runBrowserJourney } from "./support/runner.ts";

try {
  await runBrowserJourney("review", runReviewJourney);
} catch (error) {
  // The runner emits only fixed labels and artifact paths, never assertion
  // messages that may contain credentials or response bodies.
  console.error(error instanceof Error ? error.message : "Web journey could not start");
  process.exitCode = 1;
}
