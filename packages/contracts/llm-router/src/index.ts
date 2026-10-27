import { z } from "zod";
import type { Operation, OperationAccess } from "@slop-lab/dim-contracts-operations";
const id = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const nonnegative = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const empty = z.strictObject({});
const projectInput = z.strictObject({ projectId: id });
export const limitsSchema = z.strictObject({ concurrent: positive.nullable(), requestsPerUtcDay: positive.nullable(), requestBytes: positive.nullable(), responseBytes: positive.nullable(), captureBytesPerProject: positive.nullable(), deadlineMilliseconds: positive.nullable() });
export const policySchema = z.strictObject({ allowedRoutes: z.array(id).min(1).max(1000), limits: limitsSchema, captureMode: z.enum(["required", "best-effort", "metadata"]), tokenMode: z.enum(["observe", "estimate"]), tokensPerUtcDay: positive.optional(), estimatedTokensPerRequest: positive.optional() }).refine((p) => new Set(p.allowedRoutes).size === p.allowedRoutes.length && (p.tokenMode !== "estimate" || (p.tokensPerUtcDay !== undefined && p.estimatedTokensPerRequest !== undefined)), "invalid route or token admission policy");
export const projectSchema = z.strictObject({ id, enabled: z.boolean(), paused: z.boolean(), revision: z.string(), policy: policySchema });
export const routerModelSchema = z.strictObject({ id: z.string().max(200), name: z.string(), api: z.enum(["responses", "chat"]), context: positive.optional(), output: positive.optional() });
export const routerModelsSchema = z.union([z.literal("all"), z.array(routerModelSchema).min(1).max(1000)]);
const overview = z.strictObject({ backend: z.strictObject({ name: z.string(), version: z.string(), accountSelection: z.string(), attemptVisibility: z.string(), cancellation: z.string() }), accounts: z.array(z.strictObject({ id, reference: z.string() })), routes: z.array(z.strictObject({ id, accountId: id, models: routerModelsSchema })), limits: limitsSchema });
const scalar = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);
const metadata = z.record(z.string(), scalar);
const allowance = z.strictObject({ utcDay: z.string(), enabled: z.boolean(), paused: z.boolean(), booking: z.string(), projectLimits: limitsSchema, serviceLimits: z.union([limitsSchema, z.string()]), admittedRequests: nonnegative, remainingRequests: nonnegative.nullable(), occupied: nonnegative, serviceOccupied: nonnegative, tokenMode: z.enum(["observe", "estimate"]), tokenLimit: nonnegative.nullable(), chargedTokensOrEstimates: nonnegative, unknownUnreservedRequests: nonnegative, tokenReservations: nonnegative, tokenAllowanceStatus: z.string(), remainingEstimatedTokens: nonnegative.nullable(), estimatedTokenOverage: nonnegative.nullable() });
const usage = z.strictObject({ projectId: id, requests: nonnegative, knownInputTokens: nonnegative.nullable(), knownOutputTokens: nonnegative.nullable(), unknownUsageRequests: nonnegative.nullable(), captureBytes: nonnegative.nullable(), occupied: nonnegative.nullable(), backendDispatches: nonnegative.nullable(), tokenReservations: nonnegative.nullable(), allowance, recent: z.array(metadata).max(100), observedAt: nonnegative, period: z.string(), attemptVisibility: z.string(), accounting: z.string() });
const health = z.array(z.strictObject({ accountId: id, reference: z.string(), observedAt: z.string(), localCredentialReadable: z.boolean().optional(), backendAuthentication: z.string(), status: z.number().optional(), providerReachability: z.string(), providerQuota: z.string(), billableInferencePerformed: z.boolean(), credentialLifecycleOwner: z.string().optional(), exclusiveBinding: z.string().optional() }));
const principal = z.strictObject({ id: z.string(), project_id: id, workspace_id: z.string(), workspace_name: z.string(), route_id: id, enabled: z.number().int() });
const request = z.strictObject({ id: z.string().uuid(), project_id: id, principal_id: z.string(), account_id: id, started_at: nonnegative, finished_at: nonnegative.nullable(), model: z.string(), outcome: z.string(), execution: z.string(), delivery: z.string(), accounting: z.string(), occupied: nonnegative, cancel_requested: nonnegative, input_tokens: nonnegative.nullable(), output_tokens: nonnegative.nullable(), error_code: z.string().nullable() });
function operation<I, O>(name: string, description: string, access: OperationAccess, input: z.ZodType<I>, output: z.ZodType<O>): Operation<I, O> { return { name, description, access, parseInput: (value) => input.parse(value), parseOutput: (value) => output.parse(value) }; }
export const capabilitiesSchema = z.array(z.strictObject({ name: z.string(), description: z.string(), access: z.enum(["read", "operator", "reviewer"]) })).max(1000);
export const llmRouterRejectionCodeSchema = z.enum(["llm_router_authentication_failed", "llm_router_permission_denied", "llm_router_operation_rejected"]);
export type LlmRouterRejectionCode = z.infer<typeof llmRouterRejectionCodeSchema>;
export const llmRouterControllerResultSchema = z.discriminatedUnion("outcome", [
  z.strictObject({ schemaVersion: z.literal(1), outcome: z.literal("success"), output: z.unknown() }),
  z.strictObject({ schemaVersion: z.literal(1), outcome: z.literal("rejected"), status: z.number().int().min(400).max(499), errorCode: llmRouterRejectionCodeSchema }),
]);
export type LlmRouterControllerResult = z.infer<typeof llmRouterControllerResultSchema>;
export const routerAccountSchema = z.strictObject({ id, reference: z.string(), provider: z.enum(["backend", "codex", "openai", "anthropic"]), status: z.enum(["configured", "connected", "authorization_required"]) });
const accountInput = z.strictObject({ accountId: id });
const createAccountInput = z.strictObject({ accountId: id.optional(), reference: z.string().trim().min(1).max(200).optional(), provider: z.enum(["codex", "openai", "anthropic"]), endpoint: z.string().url().max(2048).refine((value) => { try { const endpoint = new URL(value); return !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash && (endpoint.protocol === "https:" || endpoint.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(endpoint.hostname)); } catch { return false; } }, "API endpoint requires HTTPS or loopback HTTP without credentials, query or fragment").optional(), apiKey: z.string().min(1).max(16384).regex(/^[^\r\n]+$/).optional() }).superRefine((value, context) => {
  if (value.provider === "codex" ? value.endpoint !== undefined || value.apiKey !== undefined : value.endpoint === undefined || value.apiKey === undefined) context.addIssue({ code: "custom", message: "Codex uses device login; API providers require endpoint and API key" });
});
export const accountManagementOperationNames = ["account.create", "account.rename", "account.login.start", "account.login.status", "route.upsert"];
export const llmOperations: readonly Operation[] = [
  operation("capabilities", "Operations allowed for the authenticated operator actor", "read", empty, capabilitiesSchema),
  operation("overview", "Accounts, routes, models and service limits", "read", empty, overview),
  operation("accounts", "List connected provider accounts without secrets", "read", empty, z.array(routerAccountSchema)),
  operation("account.models", "Discover models served by one connected account", "read", accountInput, z.array(routerModelSchema).max(10000)),
  operation("account.create", "Connect an independent Codex or compatible API account", "operator", createAccountInput, routerAccountSchema),
  operation("account.rename", "Change a managed account label without changing its identity or routes", "operator", accountInput.extend({ reference: z.string().trim().min(1).max(200) }), routerAccountSchema),
  operation("account.login.start", "Start Codex device authorization for one account", "operator", accountInput, z.strictObject({ accountId: id, sessionId: z.string(), verificationUrl: z.string().url(), userCode: z.string().optional(), status: z.enum(["pending", "connected"]), expiresAt: nonnegative })),
  operation("account.login.status", "Check one Codex authorization session", "operator", accountInput.extend({ sessionId: z.string().min(1).max(128) }), z.strictObject({ accountId: id, sessionId: z.string(), status: z.enum(["pending", "connected", "failed"]), message: z.string().optional() })),
  operation("route.upsert", "Bind a route to all account models or an explicit model list", "operator", z.strictObject({ routeId: id, accountId: id, models: routerModelsSchema }), z.strictObject({ id, accountId: id, models: routerModelsSchema })),
  operation("health", "Probe configured backend authentication without inference", "read", empty, health),
  operation("projects", "List project routing policies and state", "read", empty, z.array(projectSchema)),
  operation("project.create", "Create a project with the selected route", "operator", z.strictObject({ projectId: id, routeId: id }), projectSchema),
  operation("project.policy", "Read a project's routing policy", "read", projectInput, projectSchema),
  operation("project.policy.update", "Replace a project's routing policy", "operator", projectInput.extend({ policy: policySchema, expectedRevision: z.string().regex(/^[a-f0-9]{64}$/) }), projectSchema),
  operation("project.state", "Pause, resume, enable or disable a project", "operator", projectInput.extend({ action: z.enum(["pause", "resume", "enable", "disable"]) }), projectSchema),
  operation("usage", "Project usage and admission reservations", "read", projectInput, usage),
  operation("principals", "List workspace credentials without credential hashes", "read", empty, z.array(principal)),
  operation("principal.revoke", "Revoke a workspace credential", "operator", z.strictObject({ principalId: z.string().min(1).max(128) }), z.strictObject({ revoked: z.literal(true) })),
  operation("requests", "List bounded request metadata without prompt or response content", "read", z.strictObject({ projectId: id.optional(), active: z.boolean().optional(), limit: positive.max(200).optional() }), z.array(request)),
  operation("request.cancel", "Request cancellation; upstream termination is unconfirmed", "operator", z.strictObject({ requestId: z.string().uuid() }), z.strictObject({ cancellationRequested: z.literal(true), upstreamTerminationConfirmed: z.literal(false) })),
  operation("request.resolve", "Resolve an indeterminate request with optional observed token usage", "operator", z.strictObject({ requestId: z.string().uuid(), usage: z.strictObject({ inputTokens: nonnegative, outputTokens: nonnegative }).optional() }), z.strictObject({ resolved: z.literal(true) }))
];
export function llmOperation(name: string): Operation { const operation = llmOperations.find((op) => op.name === name); if (!operation) throw new Error("unknown LLM router operation"); return operation; }
