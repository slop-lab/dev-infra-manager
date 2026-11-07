import { z } from "zod";
export const executionArtifactLimits = { files: 128, fileBytes: 128 * 1024 * 1024, totalBytes: 256 * 1024 * 1024, chunkBytes: 256 * 1024 } as const;
export const executionArtifactIdSchema = z.string().regex(/^[0-9a-f]{64}$/);
export const executionArtifactSchema = z.object({
  id: executionArtifactIdSchema,
  name: z.string().min(1).max(512).refine(value => !value.startsWith("/") && !/[\\\x00-\x1f\x7f]/.test(value) && value.split("/").every(part => part.length > 0 && part !== "." && part !== "..")),
  bytes: z.number().int().min(0).max(executionArtifactLimits.fileBytes),
  sha256: z.string().regex(/^sha256:[0-9a-f]{64}$/), mediaType: z.string().min(1).max(100).regex(/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/)
}).strict().readonly();
export const executionArtifactManifestSchema = z.object({ executionId: z.string().uuid(), descriptorDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  availability: z.enum(["complete", "unavailable"]), error: z.string().min(1).max(256).optional(), artifacts: z.array(executionArtifactSchema).max(executionArtifactLimits.files)
}).strict().readonly().superRefine((value, ctx) => {
  if (new Set(value.artifacts.map(x => x.id)).size !== value.artifacts.length || new Set(value.artifacts.map(x => x.name)).size !== value.artifacts.length
    || value.artifacts.reduce((sum, x) => sum + x.bytes, 0) > executionArtifactLimits.totalBytes || (value.availability === "unavailable") !== (value.error !== undefined)) ctx.addIssue({ code: "custom", message: "invalid execution artifact manifest" });
});
export type ExecutionArtifact = z.infer<typeof executionArtifactSchema>;
export type ExecutionArtifactManifest = z.infer<typeof executionArtifactManifestSchema>;
export const executionArtifactChunkSchema = z.object({ descriptorDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/), artifact: executionArtifactSchema,
  offset: z.number().int().nonnegative().max(executionArtifactLimits.fileBytes), base64: z.string().max(4 * Math.ceil(executionArtifactLimits.chunkBytes / 3)).refine(x => Buffer.from(x, "base64").toString("base64") === x && Buffer.from(x, "base64").length <= executionArtifactLimits.chunkBytes)
}).strict();
