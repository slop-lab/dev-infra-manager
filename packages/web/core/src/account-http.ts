import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { AccountChangeError, changeWebAccount } from "./accounts.js";
import { accountRolesSchema, type WebConfig } from "./config.js";
import { HttpResponseError, readJson, sendJson } from "./http-response.js";
import { accountRoles, requireMutation, sendAuthenticationBusy } from "./session-http.js";
import type { AccountAuthenticator, SessionStore, WebSession } from "./session.js";

interface AccountHttpContext {
  readonly accountConfigPath: string;
  readonly authenticator: AccountAuthenticator;
  config: WebConfig;
  readonly sessions: SessionStore;
}

const accountMutationBase = z.object({ username: z.string().min(1).max(256), currentPassword: z.string().min(1).max(1024) });
const accountMutationSchema = z.discriminatedUnion("operation", [
  accountMutationBase.extend({ operation: z.literal("add"), roles: accountRolesSchema }).strict(),
  accountMutationBase.extend({ operation: z.literal("set-roles"), roles: accountRolesSchema }).strict(),
  accountMutationBase.extend({ operation: z.literal("reset-password") }).strict(),
  accountMutationBase.extend({ operation: z.literal("remove") }).strict()
]);

export async function handleAccounts(context: AccountHttpContext, session: WebSession, request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (!accountRoles(context.config, session).includes("account-admin")) throw new HttpResponseError(403, "Account administrator access is required");
  if (request.method === "GET") return sendJson(response, { status: 200, body: { accounts: context.config.accounts.map(({ username, roles }) => ({ username, roles })) } });
  if (request.method !== "POST") throw new HttpResponseError(405, "method not allowed");
  requireMutation(context.config, request, session);
  const input = accountMutationSchema.parse(await readJson(request));
  const actor = context.config.accounts.find((account) => account.username === session.accountId);
  if (!actor?.roles.includes("account-admin") || context.sessions.get(session.id) !== session) throw new HttpResponseError(403, "Account access changed. Sign in again before changing accounts");
  const authentication = await context.authenticator.authenticate(actor.username, input.currentPassword);
  if (context.sessions.get(session.id) !== session || context.config.accounts.find((account) => account.username === session.accountId) !== actor) throw new HttpResponseError(403, "Account access changed. Sign in again before changing accounts");
  if (authentication.kind === "busy") return sendAuthenticationBusy(response);
  if (authentication.kind !== "accepted") throw new HttpResponseError(403, "Current password is incorrect");
  const change = input.operation === "add" || input.operation === "set-roles"
    ? { operation: input.operation, username: input.username, roles: input.roles }
    : { operation: input.operation, username: input.username };
  try {
    const result = await changeWebAccount(context.accountConfigPath, change, {
      authorize(config) {
        const current = config.accounts.find((account) => account.username === actor.username);
        if (context.sessions.get(session.id) !== session || !current?.roles.includes("account-admin")
          || current.passwordHash !== actor.passwordHash || JSON.stringify(current.roles) !== JSON.stringify(actor.roles)) {
          throw new HttpResponseError(403, "Account access changed. Sign in again before changing accounts");
        }
      },
      committed(config) {
        context.config = { ...context.config, accounts: config.accounts };
        context.authenticator.replaceAccounts(config.accounts);
        if (input.operation !== "add") context.sessions.deleteAccount(input.username);
      }
    });
    sendJson(response, { status: 200, body: { accounts: result.accounts, username: result.username,
      ...(result.password === undefined ? {} : { password: result.password }), signInRequired: input.operation !== "add" && input.username === session.accountId } });
  } catch (error) {
    if (error instanceof AccountChangeError) throw new HttpResponseError(409, error.message);
    throw error;
  }
}
