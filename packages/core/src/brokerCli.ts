#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { parseBrokerPollRequest, parseScheduleProposal, ProtocolError } from "@slop-lab/dim-core";

const MAX_REQUEST_BYTES = 16_384;

async function main(): Promise<void> {
  if (process.argv[2] !== "broker" || process.argv[3] !== "stdio" || process.argv.length !== 4) {
    throw new ProtocolError("usage: dim-control-plane broker stdio");
  }
  const proposalFile = process.env.DIM_CONTROL_PLANE_PROPOSAL_FILE;
  if (proposalFile === undefined || !proposalFile.startsWith("/")) {
    throw new ProtocolError("DIM_CONTROL_PLANE_PROPOSAL_FILE must be an absolute path");
  }
  let requestText = "";
  for await (const chunk of process.stdin) {
    requestText += String(chunk);
    if (Buffer.byteLength(requestText) > MAX_REQUEST_BYTES) throw new ProtocolError("broker request is too large");
  }
  const request = parseBrokerPollRequest(JSON.parse(requestText));
  const proposal = parseScheduleProposal(JSON.parse(await readFile(proposalFile, "utf8")));
  if (proposal.projectId !== request.projectId || proposal.requestId !== request.requestId) {
    throw new ProtocolError("queued proposal does not match the bounded poll identity");
  }
  process.stdout.write(`${JSON.stringify(proposal)}\n`);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
