import type { PolicySectionOwner } from "@slop-lab/gs-repository-service";
import { z } from "zod";

export const mergePolicySchema = z.object({}).strict().readonly();

export const mergePolicySectionOwner: PolicySectionOwner<z.infer<typeof mergePolicySchema>> = {
  sectionName: "merge-policy",
  enforcement: "authorization",
  parse(value) { return mergePolicySchema.parse(value); },
};
