import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { NativeOrdinaryHostJournal } from "../../../../core/packages/managed/src/nativeOrdinaryHostJournal.js";
import { execution } from "./nativeOrdinaryExecutorFixture.js";

const journalPath = process.argv[2];
if (journalPath === undefined) throw new Error("journal path is required");
const checkpoint = process.argv[3];
if (checkpoint === undefined) throw new Error("checkpoint is required");

const journal = new NativeOrdinaryHostJournal(journalPath);
const claim = execution().claim;
const planned = { schemaVersion: 1, state: "planned", rootId: randomUUID() } as const;
await journal.save({ kind: "active", claim, privateRoot: planned });
const privateRoot = journal.privateRoot(planned);
const stop = async (point: string): Promise<void> => {
  if (checkpoint !== point) return;
  process.stdout.write(`${privateRoot.path}\n`);
  await new Promise<never>(() => {});
};
const path = await privateRoot.create(claim.claimId, {
  beforeStagingMarker: () => stop("before-staging-marker"),
  afterPartialStagingMarker: () => stop("partial-staging-marker"),
  afterStagingMarkerSync: () => stop("after-marker-sync")
});
await stop("after-rename");
await journal.save({ kind: "active", claim, privateRoot: privateRoot.identity });
await writeFile(join(path, "candidate-data"), "untrusted\n");
await stop("after-created-journal");
