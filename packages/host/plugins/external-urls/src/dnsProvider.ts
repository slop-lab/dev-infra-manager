import { UserError } from "@slop-lab/dim-host-core";
import type { DimPluginHost } from "@slop-lab/dim-host-core/controller";
import { EXTERNAL_URL_DNS_PROVIDER_EXTENSION, type ExternalUrlDnsProviderDriver } from "@slop-lab/dim-contracts-external-url";

export function normalizeDnsProviderArgument(host: DimPluginHost, driver: string, argument: string): string {
  try {
    return dnsDriver(host, driver).normalizeProviderArgument(argument);
  } catch (error) {
    throw new UserError(error instanceof Error ? error.message : String(error));
  }
}

export function normalizeDnsRecordArgument(driver: ExternalUrlDnsProviderDriver, argument: string): string {
  try {
    return driver.normalizeRecordArgument(argument);
  } catch (error) {
    throw new UserError(error instanceof Error ? error.message : String(error));
  }
}

export function dnsDriver(host: DimPluginHost, name: string): ExternalUrlDnsProviderDriver {
  const driver = host.extension<ExternalUrlDnsProviderDriver>(EXTERNAL_URL_DNS_PROVIDER_EXTENSION, name);
  if (!driver) {
    throw new UserError(
      `external URL DNS provider driver '${name}' is not installed; install and enable its DIM plugin first`
    );
  }
  for (const method of [
    "normalizeProviderArgument",
    "normalizeRecordArgument",
    "ensure",
    "verify",
    "remove",
    "caddyDns01"
  ] as const) {
    if (typeof driver[method] !== "function") {
      throw new UserError(`external URL DNS provider driver '${name}' has an invalid '${method}' implementation`);
    }
  }
  return driver;
}

