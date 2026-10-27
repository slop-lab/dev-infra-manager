import { expect, it } from "vitest";
import { maximumRecordBytes } from "../../../../packages/control-plane/plugins/git-review/src/authoritative-native-review-store.js";
import { maximumProposalAcceptanceBytes } from "../../../../packages/control-plane/plugins/git-review/src/proposal-acceptance.js";

it("reserves journal wrapper bytes in addition to the complete canonical envelope byte allowance", () => {
  const envelope = { patch: "\u0000\n\"\\" };
  const canonical = `${JSON.stringify(envelope)}\n`;
  const journal = `${JSON.stringify({ schemaVersion: 1, generationId: "f".repeat(64), envelope })}\n`;
  const wrapperBytes = Buffer.byteLength(journal) - Buffer.byteLength(canonical);
  expect(wrapperBytes).toBeGreaterThan(0);
  expect(maximumProposalAcceptanceBytes).toBeGreaterThanOrEqual(maximumRecordBytes + wrapperBytes);
});
