export { createNodeNativeGitAdmissionHttpClient } from "./nativeGitAdmissionHttpClient.js";

export type NativeGitAdmissionConfig = {
  readonly endpoint: "http://native-git:8080";
  readonly serviceId: "native-main";
  readonly identity: {
    readonly username: string;
    readonly password: string;
  };
  readonly attemptIssuer: {
    readonly username: string;
    readonly password: string;
  };
};

export type NativeGitAdmissionHttpRequest = {
  readonly endpoint: string;
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly authorization: string;
  readonly generationId?: string;
  readonly body?: string;
  readonly signal: AbortSignal;
};

export type NativeGitAdmissionHttpResponse = {
  readonly statusCode: number;
  readonly contentType: string | undefined;
  readonly cacheControl: string | undefined;
  readonly body: Buffer;
};

export interface NativeGitAdmissionHttpClient {
  request(input: NativeGitAdmissionHttpRequest): Promise<NativeGitAdmissionHttpResponse>;
}

export class NativeAdmissionSourceUnavailableError extends Error {
  readonly name = "NativeAdmissionSourceUnavailableError";

  constructor(options?: ErrorOptions) {
    super("native admission source is unavailable", options);
  }
}

export class NativeAdmissionSourceRejectedError extends Error {
  readonly name = "NativeAdmissionSourceRejectedError";

  constructor() {
    super("native admission source rejected the tuple");
  }
}
