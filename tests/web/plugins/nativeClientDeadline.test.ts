import { createServer } from "node:http";
import { expect, it } from "vitest";
import { NativeGitClient } from "@slop-lab/dim-service-client-native-git";

it("allows real repository review reads and promotions to finish after the old five-second identity deadline", async () => {
  const generationId = "a".repeat(64), timers = new Set<ReturnType<typeof setTimeout>>();
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/v1/human-reviewer-identity") return response.end(JSON.stringify({ schemaVersion: 1, serviceId: "native-main", role: "human-reviewer", reviewerId: "owner", generationId }));
    if (request.url === "/v1/host-promoter-identity") return response.end(JSON.stringify({ schemaVersion: 1, serviceId: "native-main", role: "host-promoter", hostId: "host-a", generationId }));
    expect(request.headers["x-dim-generation-id"]).toBe(generationId);
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (request.method === "GET" && request.url?.endsWith("/reviews")) response.end("[]");
      else if (request.method === "POST" && request.url?.endsWith("/promotions")) response.end(JSON.stringify({ schemaVersion: 1, outcome: "promoted", reviewId: "b".repeat(64), protectedRef: "refs/heads/main", expectedProtectedHead: "c".repeat(40), candidateCommit: "d".repeat(40), candidateTree: "e".repeat(40) }));
      else { response.statusCode = 404; response.end("{}"); }
    }, 5_200);
    timers.add(timer);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("missing test listener");
  const client = new NativeGitClient({ baseUrl: `http://127.0.0.1:${address.port}`, generationId, reviewerId: "owner", username: "reviewer", password: "reviewer-secret", promoter: { hostId: "host-a", username: "promoter", password: "promoter-secret" } });
  try {
    await client.attest();
    const [reviews, promotion] = await Promise.all([client.listReviews("project", "main"), client.promote("project", "main", "b".repeat(64))]);
    expect(reviews).toEqual([]); expect(promotion.outcome).toBe("promoted");
  } finally {
    for (const timer of timers) clearTimeout(timer);
    server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}, 15_000);
