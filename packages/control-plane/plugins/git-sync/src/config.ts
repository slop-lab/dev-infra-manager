import { z } from "zod";

const identifier = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/);
const credential = z.object({
  username: z.string().min(1).max(256).regex(/^[^:\x00-\x20\x7f]+$/),
  password: z.string().min(1).max(4096).regex(/^[^\x00-\x20\x7f]+$/),
}).strict();

export const gitSyncConfigurationSchema = z.object({
  operators: z.array(credential.extend({
    hostId: identifier,
    password: z.string().refine((value) => Buffer.from(value, "base64url").length === 32
      && Buffer.from(value, "base64url").toString("base64url") === value),
  }).strict().readonly()).readonly(),
  credential: credential.optional(),
  allowLocalRemotes: z.boolean().default(false),
}).strict().readonly();

export type GitSyncConfiguration = z.infer<typeof gitSyncConfigurationSchema>;
