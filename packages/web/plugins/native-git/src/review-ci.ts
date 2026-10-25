import type { ReviewDto } from "@slop-lab/dim-service-client-native-git";

export function reviewCiSummary(ci: ReviewDto["ci"]): string {
  if (!ci) return "DIM CI status is unavailable. Merge remains blocked until current evidence can be read.";
  switch (ci.state) {
    case "not-configured": return "DIM CI is not configured for this repository. No successful CI claim is available.";
    case "not-required": return "DIM CI policy is enabled and requires no jobs for this change.";
    case "pending": return `DIM CI is required and pending: ${ci.requiredJobs.map(job => `${job.name} (${job.status})`).join(", ")}.`;
    case "failed": return `DIM CI failed: ${ci.requiredJobs.map(job => `${job.name} (${job.status})`).join(", ")}.`;
    case "succeeded": return `DIM CI succeeded: ${ci.requiredJobs.map(job => job.name).join(", ")}.`;
    case "stale": return "DIM CI evidence is stale for this revision. Refresh and run the required jobs again.";
    case "unavailable": return "DIM CI evidence is unavailable. Merge remains blocked; inspect execution workers and retry.";
  }
}
