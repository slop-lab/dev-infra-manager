import { z } from "zod";

export const externalWebhookEventTypeSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,255}$/);
const endpoint = z.string().max(2048).url().refine((value) => {
  const url = new URL(value);
  return !url.username && !url.password && !url.hash
    && (url.protocol === "https:" || (url.protocol === "http:"
      && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)));
});
export const externalWebhookSubscriberSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  endpoint,
  secret: z.string().startsWith("whsec_").refine((value) => {
    const encoded = value.slice(6);
    const bytes = Buffer.from(encoded, "base64");
    return bytes.length === 32 && bytes.toString("base64") === encoded;
  }),
  projects: z.array(z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/)).min(1).max(1000).readonly(),
  events: z.array(externalWebhookEventTypeSchema).min(1).max(64).readonly(),
  maximumAttempts: z.number().int().min(1).max(20).default(8),
  timeoutMilliseconds: z.number().int().min(50).max(30_000).default(5000),
  retryMilliseconds: z.number().int().min(50).max(60_000).default(1000)
}).strict().readonly();
export type ExternalWebhookSubscriber = z.infer<typeof externalWebhookSubscriberSchema>;
