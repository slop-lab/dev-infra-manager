import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";

/** Core HTTP streams have no fetch implementation's implicit response/header deadline. */
export function upstreamResponse(endpoint: string, options: { signal: AbortSignal; key: string; body: Buffer; streaming: boolean }): Promise<IncomingMessage> {
  const url = new URL(endpoint);
  return new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
      method: "POST", agent: false, timeout: 0, signal: options.signal,
      headers: { authorization: `Bearer ${options.key}`, "content-type": "application/json",
        "content-length": options.body.length, accept: options.streaming ? "text/event-stream" : "application/json" }
    }, resolve);
    request.once("error", reject);
    request.end(options.body);
  });
}
