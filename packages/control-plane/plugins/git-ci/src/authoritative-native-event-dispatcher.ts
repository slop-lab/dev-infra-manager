import { join } from "node:path";
import { z } from "zod";
import {
  CiDeliveryError,
  CiDeliveryRejectedError,
  createCiDeliveryDispatcher,
  type CiDeliveryPublicationFaults,
  type CiDeliveryDispatcher,
} from "@slop-lab/gs-ci";
import { AuthoritativeNativeReviewAdmissionBusyError } from "@slop-lab/dim-control-plane-plugin-git-review/plugin-api";
import {
  readNativeProjectRegistrations,
  type NativeGitBundleState,
} from "@slop-lab/dim-control-plane-plugin-git-repositories/plugin-api";
import type {
  NativeGitAdmissionHttpClient,
  NativeGitAdmissionHttpResponse,
} from "@slop-lab/dim-contracts-git/http";

const maximumResponseBytes = 64 * 1024;
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const acknowledgementSchema = z.object({
  executionId: z.string().uuid(),
  eventId: digest,
  generationId: digest,
}).strict().readonly();

export type AuthoritativeNativeEventDispatcher = CiDeliveryDispatcher;

export type AuthoritativeNativeEventDispatcherOptions = {
  readonly webhook: { readonly endpoint: string; readonly username: string; readonly password: string };
  readonly state: NativeGitBundleState;
  readonly stateDirectory: string;
  readonly generationId: string;
  readonly httpClient: NativeGitAdmissionHttpClient;
  readonly serialize: <Result>(operation: () => Promise<Result>) => Promise<Result>;
  readonly deliveryFaults?: CiDeliveryPublicationFaults;
  readonly minimumRetryMilliseconds?: number;
  readonly maximumRetryMilliseconds?: number;
  readonly idleMilliseconds?: number;
  readonly requestTimeoutMilliseconds?: number;
};

export function createAuthoritativeNativeEventDispatcher(
  options: AuthoritativeNativeEventDispatcherOptions,
): Promise<AuthoritativeNativeEventDispatcher> {
  return createCiDeliveryDispatcher({
    serviceId: "ci",
    destination: options.webhook.endpoint,
    generationId: options.generationId,
    repositories: () => readNativeProjectRegistrations(options.state).map((registration) =>
      join(options.stateDirectory, registration.projectId, `${registration.repositoryId}.git`)),
    submit: {
      async submit(input) {
        const receipt = { generationId: input.generationId, event: input.event } as const;
        const acknowledgement = acknowledgementSchema.safeParse(await requestJson(options.httpClient, {
          endpoint: options.webhook.endpoint,
          method: "POST",
          path: new URL(options.webhook.endpoint).pathname,
          authorization: authorization(options.webhook),
          body: JSON.stringify(receipt),
          signal: input.signal,
        }, 202));
        if (!acknowledgement.success) {
          throw new AuthoritativeNativeEventDeliveryError("ordinary receipt acknowledgement is malformed");
        }
        if (acknowledgement.data.generationId !== input.generationId
          || acknowledgement.data.eventId !== input.event.eventId) {
          throw new AuthoritativeNativeEventDeliveryError("ordinary receipt acknowledgement does not match delivery");
        }
        return {
          serviceId: "ci",
          generationId: acknowledgement.data.generationId,
          executionId: acknowledgement.data.executionId,
        };
      },
    },
    serialize: options.serialize,
    transientError: (error) => error instanceof AuthoritativeNativeReviewAdmissionBusyError,
    ...(options.deliveryFaults === undefined ? {} : { deliveryFaults: options.deliveryFaults }),
    ...(options.minimumRetryMilliseconds === undefined ? {} : {
      minimumRetryMilliseconds: options.minimumRetryMilliseconds,
    }),
    ...(options.maximumRetryMilliseconds === undefined ? {} : {
      maximumRetryMilliseconds: options.maximumRetryMilliseconds,
    }),
    ...(options.idleMilliseconds === undefined ? {} : { idleMilliseconds: options.idleMilliseconds }),
    ...(options.requestTimeoutMilliseconds === undefined ? {} : {
      requestTimeoutMilliseconds: options.requestTimeoutMilliseconds,
    }),
  });
}

async function requestJson(
  client: NativeGitAdmissionHttpClient,
  input: Parameters<NativeGitAdmissionHttpClient["request"]>[0],
  expectedStatus: 202,
): Promise<unknown> {
  let response: NativeGitAdmissionHttpResponse;
  try {
    response = await client.request(input);
  } catch (error) {
    throw new AuthoritativeNativeEventDeliveryError("ordinary delivery request failed", { cause: error });
  }
  if ((response.statusCode === 404 || response.statusCode === 409)
    && response.contentType === "application/json" && response.cacheControl === "no-store"
    && response.body.length <= maximumResponseBytes) {
    throw new CiDeliveryRejectedError(response.statusCode);
  }
  if (response.statusCode !== expectedStatus || response.contentType !== "application/json"
    || response.cacheControl !== "no-store" || response.body.length > maximumResponseBytes) {
    throw new AuthoritativeNativeEventDeliveryError("ordinary delivery response is invalid");
  }
  try {
    return JSON.parse(response.body.toString("utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new AuthoritativeNativeEventDeliveryError("ordinary delivery response is malformed", { cause: error });
    }
    throw error;
  }
}

function authorization(credential: { readonly username: string; readonly password: string }): string {
  return `Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString("base64")}`;
}

export class AuthoritativeNativeEventDeliveryError extends CiDeliveryError {
  readonly name: string = "AuthoritativeNativeEventDeliveryError";
}
