import path from "node:path";
import { selectedControlPlaneHostFile } from "@slop-lab/dim-host-plugin-native-git";
import { UserError } from "@slop-lab/dim-host-core";
import { createCiQueryClient as createClient } from "@slop-lab/dim-execution-client";

/** CLI default selection belongs to the operator adapter, not the remote client. */
export async function createCiQueryClient(override?: string, environment: NodeJS.ProcessEnv = process.env) {
  const file = override === undefined ? path.join(path.dirname(await selectedControlPlaneHostFile(environment)), "ci-query.json") : path.resolve(override);
  try { return await createClient(file); }
  catch (error) { throw new UserError(`cannot load private CI query connection '${file}'; run 'dim control-plane connect SETUP' or select --connection FILE`, { cause: error }); }
}
