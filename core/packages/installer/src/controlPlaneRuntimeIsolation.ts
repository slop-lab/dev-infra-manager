import { ControlPlaneDockerError } from "./controlPlaneDockerTypes.js";

export type ControlPlaneRuntimeIsolationFields = {
  readonly devices: string | undefined;
  readonly deviceRequests: string | undefined;
  readonly deviceCgroupRules: string | undefined;
  readonly pidMode: string | undefined;
  readonly ipcMode: string | undefined;
  readonly utsMode: string | undefined;
  readonly cgroupnsMode: string | undefined;
  readonly usernsMode: string | undefined;
  readonly networkMode: string | undefined;
};

type ControlPlaneRuntimeIsolation = {
  readonly devices: readonly unknown[] | null;
  readonly deviceRequests: readonly unknown[] | null;
  readonly deviceCgroupRules: readonly unknown[] | null;
  readonly pidMode: string;
  readonly ipcMode: string;
  readonly utsMode: string;
  readonly cgroupnsMode: string;
  readonly usernsMode: string;
  readonly networkMode: string;
};

export function assertControlPlaneRuntimeIsolation(
  fields: ControlPlaneRuntimeIsolationFields,
  expectedNetworkMode: string
): void {
  const isolation = parseRuntimeIsolation(fields);
  if (isolation.devices !== null || isolation.deviceRequests !== null || isolation.deviceCgroupRules !== null) {
    throw new ControlPlaneDockerError("control-plane running device topology differs from installed state");
  }
  if (isolation.pidMode !== "" || isolation.ipcMode !== "private" || isolation.utsMode !== ""
    || isolation.cgroupnsMode !== "private" || isolation.usernsMode !== ""
    || isolation.networkMode !== expectedNetworkMode) {
    throw new ControlPlaneDockerError("control-plane running namespace topology differs from installed state");
  }
}

function parseRuntimeIsolation(fields: ControlPlaneRuntimeIsolationFields): ControlPlaneRuntimeIsolation {
  return {
    devices: parseNullableArray(fields.devices),
    deviceRequests: parseNullableArray(fields.deviceRequests),
    deviceCgroupRules: parseNullableArray(fields.deviceCgroupRules),
    pidMode: parseString(fields.pidMode),
    ipcMode: parseString(fields.ipcMode),
    utsMode: parseString(fields.utsMode),
    cgroupnsMode: parseString(fields.cgroupnsMode),
    usernsMode: parseString(fields.usernsMode),
    networkMode: parseString(fields.networkMode)
  };
}

function parseNullableArray(value: string | undefined): readonly unknown[] | null {
  const parsed = parseJson(value);
  if (parsed !== null && !Array.isArray(parsed)) malformed();
  return parsed;
}

function parseString(value: string | undefined): string {
  const parsed = parseJson(value);
  if (typeof parsed !== "string") return malformed();
  return parsed;
}

function parseJson(value: string | undefined): unknown {
  if (value === undefined) return malformed();
  try {
    return JSON.parse(value);
  } catch (error) {
    if (error instanceof SyntaxError) return malformed(error);
    throw error;
  }
}

function malformed(cause?: SyntaxError): never {
  throw new ControlPlaneDockerError("control-plane running isolation topology is malformed", {
    ...(cause === undefined ? {} : { cause })
  });
}
