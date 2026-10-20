import { z } from "zod";
const identifier = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
export const mergePolicyConfigurationSchema = z.object({ hostPromoters: z.array(z.object({
  hostId: identifier, username: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), password: z.string().min(32).max(256)
}).strict()).max(1000) }).strict().superRefine((value, context) => {
  if (new Set(value.hostPromoters.map(({ username }) => username)).size !== value.hostPromoters.length) context.addIssue({ code: "custom", message: "duplicate promoter username" });
});
