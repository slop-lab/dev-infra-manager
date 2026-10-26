import { loadPrivateJson, reviewerConnectionSchema } from "@slop-lab/dim-service-client-native-git";
import { dirname, join } from "node:path";
import { UserError } from "@slop-lab/dim-host-core";
import { selectedControlPlaneHostFile } from "../controlPlaneSelection.js";
import type { NativeControlPlaneConnection } from "../nativeControlPlaneConnection.js";

export async function selectedRepositoryReviewer(selected: NativeControlPlaneConnection): Promise<string> {
  const file = join(dirname(await selectedControlPlaneHostFile()), "reviewer.json");
  let reviewer;
  try { reviewer = reviewerConnectionSchema.parse(await loadPrivateJson(file)); }
  catch { throw new UserError("Repository import requires the selected control plane's reviewer connection; connect its Git review feature first"); }
  if (reviewer.baseUrl !== selected.nativeGit.endpoint || reviewer.generationId !== selected.nativeGit.generationId) throw new UserError("Reviewer connection conflicts with selected control plane");
  return reviewer.reviewerId;
}
